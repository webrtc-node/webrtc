#include <napi.h>
#include <rtc/rtc.hpp>

#include "certificate.hpp"
#include "send_queue.hpp"
#include "teardown_tasks.hpp"

#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

class NativeDataChannel;
class NativeIceUdpMuxListener;
struct ChannelBinding;
struct EventDispatcher;
struct IceUdpMuxBinding;
struct PeerBinding;
struct EnvironmentState;
void CleanupEnvironment(EnvironmentState *state);

using webrtc_node::PeerSendHandoff;
using webrtc_node::SendQueue;
using webrtc_node::TeardownTasks;

struct EnvironmentState {
	Napi::FunctionReference dataChannelConstructor;
	std::vector<std::weak_ptr<PeerBinding>> peers;
	std::vector<std::weak_ptr<IceUdpMuxBinding>> listeners;
	std::shared_ptr<SendQueue> sendQueue = std::make_shared<SendQueue>();
	std::shared_ptr<TeardownTasks> teardownTasks = std::make_shared<TeardownTasks>();
	Napi::Env::CleanupHook<decltype(&CleanupEnvironment), EnvironmentState> cleanupHook;
};

std::mutex environmentMutex;
size_t environmentCount = 0;

// Unlike the untyped wrapper, dispatch also runs with a null environment so
// queued native payloads are reclaimed when Node discards callbacks at exit.
class NativeDispatcher {
	using Job = std::function<void(Napi::Env, Napi::Function)>;
	static void Dispatch(Napi::Env env, Napi::Function callback, void *, Job *job) {
		std::unique_ptr<Job> owned(job);
		(*owned)(env, callback);
	}
	using Function = Napi::TypedThreadSafeFunction<void, Job, Dispatch>;
	Function function;
	bool released = false;

public:
	static NativeDispatcher New(Napi::Env env, Napi::Function callback, const char *name) {
		NativeDispatcher dispatcher;
		dispatcher.function = Function::New(env, callback, name, 0, 1);
		// Cleanup hooks run in reverse registration order. Stop our producers before
		// Node closes any of the thread-safe function handles they can still call.
		auto *state = env.GetInstanceData<EnvironmentState>();
		state->cleanupHook.Remove(env);
		state->cleanupHook = env.AddCleanupHook(CleanupEnvironment, state);
		return dispatcher;
	}
	template <typename Data, typename Callback>
	napi_status NonBlockingCall(Data *data, Callback callback) {
		if (released)
			return napi_closing;
		auto job = std::make_unique<Job>([data, callback](Napi::Env env, Napi::Function fn) {
			callback(env, fn, data);
		});
		auto status = function.NonBlockingCall(job.get());
		if (status == napi_ok)
			job.release();
		// Node consumes our acquisition when environment shutdown returns napi_closing.
		// The handle must never be used again, including by Release().
		else if (status == napi_closing)
			released = true;
		return status;
	}
	void Unref(Napi::Env env) { function.Unref(env); }
	void Release() {
		if (!released) {
			released = true;
			function.Release();
		}
	}
};

std::atomic<uint32_t> nextChannelId{1};
constexpr auto PEER_CLOSE_TIMEOUT = std::chrono::seconds(5);
constexpr auto PEER_CLOSE_HANDOFF_GRACE = std::chrono::milliseconds(50);

uint32_t AllocateChannelId() {
	uint32_t id;
	do {
		id = nextChannelId.fetch_add(1, std::memory_order_relaxed);
	} while (id == 0);
	return id;
}

struct PeerCloseSignal {
	std::mutex mutex;
	std::condition_variable condition;
	bool closed = false;
};

struct PeerTeardownWork {
	std::shared_ptr<rtc::PeerConnection> peerConnection;
	std::vector<std::shared_ptr<rtc::DataChannel>> dataChannels;
};

void CloseDataChannelForTeardown(const std::shared_ptr<rtc::DataChannel> &dataChannel) {
	if (!dataChannel)
		return;
	try {
		dataChannel->resetCallbacks();
		dataChannel->close();
	} catch (...) {
	}
}

void RunPeerTeardown(PeerTeardownWork work) {
	auto closeSignal = std::make_shared<PeerCloseSignal>();
	work.peerConnection->onStateChange([closeSignal](rtc::PeerConnection::State state) {
		if (state != rtc::PeerConnection::State::Closed)
			return;
		{
			std::lock_guard<std::mutex> lock(closeSignal->mutex);
			closeSignal->closed = true;
		}
		closeSignal->condition.notify_all();
	});

	for (auto &dataChannel : work.dataChannels) {
		CloseDataChannelForTeardown(dataChannel);
	}
	work.dataChannels.clear();

	try {
		work.peerConnection->close();
	} catch (...) {
	}

	{
		std::unique_lock<std::mutex> lock(closeSignal->mutex);
		closeSignal->condition.wait_for(lock, PEER_CLOSE_TIMEOUT, [&]() {
			return closeSignal->closed ||
			       work.peerConnection->state() == rtc::PeerConnection::State::Closed;
		});
	}
	work.peerConnection->resetCallbacks();
	work.peerConnection.reset();
}

std::string ToString(rtc::PeerConnection::State state) {
	switch (state) {
	case rtc::PeerConnection::State::New:
		return "new";
	case rtc::PeerConnection::State::Connecting:
		return "connecting";
	case rtc::PeerConnection::State::Connected:
		return "connected";
	case rtc::PeerConnection::State::Disconnected:
		return "disconnected";
	case rtc::PeerConnection::State::Failed:
		return "failed";
	case rtc::PeerConnection::State::Closed:
		return "closed";
	}
	return "closed";
}

std::string ToString(rtc::PeerConnection::IceState state) {
	switch (state) {
	case rtc::PeerConnection::IceState::New:
		return "new";
	case rtc::PeerConnection::IceState::Checking:
		return "checking";
	case rtc::PeerConnection::IceState::Connected:
		return "connected";
	case rtc::PeerConnection::IceState::Completed:
		return "completed";
	case rtc::PeerConnection::IceState::Failed:
		return "failed";
	case rtc::PeerConnection::IceState::Disconnected:
		return "disconnected";
	case rtc::PeerConnection::IceState::Closed:
		return "closed";
	}
	return "closed";
}

std::string ToString(rtc::PeerConnection::GatheringState state) {
	switch (state) {
	case rtc::PeerConnection::GatheringState::New:
		return "new";
	case rtc::PeerConnection::GatheringState::InProgress:
		return "gathering";
	case rtc::PeerConnection::GatheringState::Complete:
		return "complete";
	}
	return "complete";
}

std::string ToString(rtc::PeerConnection::SignalingState state) {
	switch (state) {
	case rtc::PeerConnection::SignalingState::Stable:
		return "stable";
	case rtc::PeerConnection::SignalingState::HaveLocalOffer:
		return "have-local-offer";
	case rtc::PeerConnection::SignalingState::HaveRemoteOffer:
		return "have-remote-offer";
	case rtc::PeerConnection::SignalingState::HaveLocalPranswer:
		return "have-local-pranswer";
	case rtc::PeerConnection::SignalingState::HaveRemotePranswer:
		return "have-remote-pranswer";
	}
	return "stable";
}

rtc::Description::Type ParseDescriptionType(const std::string &type) {
	if (type.empty())
		return rtc::Description::Type::Unspec;
	return rtc::Description::stringToType(type);
}

Napi::Object DescriptionToObject(Napi::Env env, const rtc::Description &description) {
	Napi::Object result = Napi::Object::New(env);
	result.Set("type", description.typeString());
	result.Set("sdp", std::string(description));
	return result;
}

rtc::LocalDescriptionInit ParseLocalDescriptionInit(const Napi::Value &value) {
	rtc::LocalDescriptionInit init;
	if (!value.IsObject())
		return init;

	Napi::Object object = value.As<Napi::Object>();
	if (object.Has("iceUfrag") && !object.Get("iceUfrag").IsNull() &&
	    !object.Get("iceUfrag").IsUndefined())
		init.iceUfrag = object.Get("iceUfrag").ToString().Utf8Value();
	if (object.Has("icePwd") && !object.Get("icePwd").IsNull() &&
	    !object.Get("icePwd").IsUndefined())
		init.icePwd = object.Get("icePwd").ToString().Utf8Value();
	return init;
}

struct ChannelOptions {
	bool ordered = true;
	bool negotiated = false;
	std::optional<uint16_t> id;
	std::optional<uint32_t> maxPacketLifeTime;
	std::optional<uint32_t> maxRetransmits;
	std::string protocol;
};

struct NativeEvent {
	std::shared_ptr<EventDispatcher> dispatcher;
	std::string target;
	std::string type;
	uint32_t channelId = 0;
	std::shared_ptr<ChannelBinding> channel;
	std::string state;
	std::string descriptionType;
	std::string sdp;
	std::string candidate;
	std::string mid;
	std::string error;
	bool binary = false;
	std::string text;
	rtc::binary bytes;
};

struct EventDispatcher : public std::enable_shared_from_this<EventDispatcher> {
	static std::shared_ptr<EventDispatcher> Create(Napi::Env env, Napi::Function callback) {
		return std::shared_ptr<EventDispatcher>(new EventDispatcher(env, callback));
	}

	~EventDispatcher() { Close(); }

	void Emit(NativeEvent event) {
		if (event.target != "datachannel" || event.type != "message") {
			EmitDirect(std::move(event));
			return;
		}

		bool scheduleDispatch = false;
		std::lock_guard<std::mutex> lock(lifecycleMutex);
		if (!active) {
			return;
		}

		pendingEvents.push_back(std::move(event));
		if (!dispatchScheduled) {
			dispatchScheduled = true;
			scheduleDispatch = true;
		}
		if (!scheduleDispatch)
			return;

		QueueDispatchLocked();
	}

	void EmitDirect(NativeEvent event) {
		event.dispatcher = shared_from_this();
		auto *queued = new NativeEvent(std::move(event));
		std::lock_guard<std::mutex> lock(lifecycleMutex);
		if (!active) {
			delete queued;
			return;
		}

		napi_status status = tsfn.NonBlockingCall(queued, DispatchDirect);
		if (status != napi_ok)
			delete queued;
	}

	void Close() {
		std::lock_guard<std::mutex> lock(lifecycleMutex);
		pendingEvents.clear();
		dispatchScheduled = false;
		if (active) {
			active = false;
			tsfn.Release();
		}
	}

private:
	EventDispatcher(Napi::Env env, Napi::Function callback)
	    : tsfn(NativeDispatcher::New(env, callback, "webrtc-node events")) {
		tsfn.Unref(env);
	}

	void Drain(Napi::Env env, Napi::Function callback) {
		std::vector<NativeEvent> events;
		{
			std::lock_guard<std::mutex> lock(lifecycleMutex);
			if (pendingEvents.empty()) {
				dispatchScheduled = false;
				return;
			}
			events.swap(pendingEvents);
		}

		if (events.size() == 1) {
			callback.Call({EventToObject(env, events.front())});
		} else {
			Napi::Array batch = Napi::Array::New(env, events.size());
			for (uint32_t i = 0; i < events.size(); ++i)
				batch.Set(i, EventToObject(env, events[i]));
			callback.Call({batch});
		}

		std::lock_guard<std::mutex> lock(lifecycleMutex);
		if (!active || pendingEvents.empty()) {
			dispatchScheduled = false;
			return;
		}
		QueueDispatchLocked();
	}

	void QueueDispatchLocked() {
		auto *dispatcher = new std::shared_ptr<EventDispatcher>(shared_from_this());
		napi_status status = tsfn.NonBlockingCall(dispatcher, DispatchQueued);
		if (status != napi_ok) {
			dispatchScheduled = false;
			pendingEvents.clear();
			delete dispatcher;
		}
	}

	static void DispatchQueued(Napi::Env env, Napi::Function callback,
	                           std::shared_ptr<EventDispatcher> *dispatcher) {
		std::shared_ptr<EventDispatcher> scoped = std::move(*dispatcher);
		delete dispatcher;
		if (!env || !callback)
			return;
		scoped->Drain(env, callback);
	}

	static void DispatchDirect(Napi::Env env, Napi::Function callback, NativeEvent *event) {
		std::unique_ptr<NativeEvent> scoped(event);
		if (!env || !callback)
			return;
		{
			std::lock_guard lock(scoped->dispatcher->lifecycleMutex);
			if (!scoped->dispatcher->active)
				return;
		}
		callback.Call({EventToObject(env, *scoped)});
	}

	static Napi::Value MessagePayloadToValue(Napi::Env env, NativeEvent &event) {
		if (!event.binary)
			return Napi::String::New(env, event.text);

		if (event.bytes.empty())
			return Napi::ArrayBuffer::New(env, 0);

		auto *bytes = new rtc::binary(std::move(event.bytes));
		return Napi::ArrayBuffer::New(
		    env, bytes->data(), bytes->size(),
		    [](Napi::Env, void *, rtc::binary *finalizedBytes) { delete finalizedBytes; },
		    bytes);
	}

	static Napi::Object EventToObject(Napi::Env env, NativeEvent &event);

	bool active = true;
	std::mutex lifecycleMutex;
	std::vector<NativeEvent> pendingEvents;
	bool dispatchScheduled = false;
	NativeDispatcher tsfn;
};

struct IceUdpMuxDispatch {
	std::shared_ptr<IceUdpMuxBinding> binding;
	rtc::IceUdpMuxRequest request;
};

struct IceUdpMuxBinding : public std::enable_shared_from_this<IceUdpMuxBinding> {
	static std::shared_ptr<IceUdpMuxBinding> Create(Napi::Env env, Napi::Function callback,
	                                                uint16_t port,
	                                                std::optional<std::string> address) {
		auto binding = std::shared_ptr<IceUdpMuxBinding>(
		    new IceUdpMuxBinding(env, callback, port, std::move(address)));
		try {
			binding->iceUdpMuxListener =
			    std::make_unique<rtc::IceUdpMuxListener>(binding->port, binding->address);
			binding->AttachCallback();
		} catch (...) {
			binding->Close();
			throw;
		}
		return binding;
	}

	~IceUdpMuxBinding() { Close(); }

	void Emit(rtc::IceUdpMuxRequest request) {
		std::lock_guard<std::mutex> lock(lifecycleMutex);
		if (!active)
			return;

		auto *dispatch = new IceUdpMuxDispatch{shared_from_this(), std::move(request)};
		napi_status status = tsfn.NonBlockingCall(dispatch, Dispatch);
		if (status != napi_ok)
			delete dispatch;
	}

	void Close() {
		std::unique_ptr<rtc::IceUdpMuxListener> listener;
		bool release = false;
		{
			std::lock_guard<std::mutex> lock(lifecycleMutex);
			if (!active)
				return;
			active = false;
			listener = std::move(iceUdpMuxListener);
			release = !tsfnReleased;
			tsfnReleased = true;
		}

		if (listener) {
			try {
				listener->OnUnhandledStunRequest(
				    std::function<void(rtc::IceUdpMuxRequest)>{});
				listener->stop();
			} catch (...) {
			}
		}
		if (release)
			tsfn.Release();
	}

	uint16_t Port() const { return port; }

	const std::optional<std::string> &Address() const { return address; }

	bool IsActive() const {
		std::lock_guard<std::mutex> lock(lifecycleMutex);
		return active;
	}

private:
	IceUdpMuxBinding(Napi::Env env, Napi::Function callback, uint16_t port_,
	                 std::optional<std::string> address_)
	    : port(port_), address(std::move(address_)),
	      tsfn(NativeDispatcher::New(env, callback, "webrtc-node ICE UDP mux")) {
		tsfn.Unref(env);
	}

	void AttachCallback() {
		std::weak_ptr<IceUdpMuxBinding> weak = shared_from_this();
		iceUdpMuxListener->OnUnhandledStunRequest([weak](rtc::IceUdpMuxRequest request) {
			if (auto self = weak.lock())
				self->Emit(std::move(request));
		});
	}

	static void Dispatch(Napi::Env env, Napi::Function callback, IceUdpMuxDispatch *dispatch) {
		std::unique_ptr<IceUdpMuxDispatch> scoped(dispatch);
		if (!env || !callback)
			return;
		{
			std::lock_guard<std::mutex> lock(scoped->binding->lifecycleMutex);
			if (!scoped->binding->active)
				return;
		}

		Napi::Object request = Napi::Object::New(env);
		request.Set("ufrag", scoped->request.remoteUfrag);
		request.Set("localUfrag", scoped->request.localUfrag);
		request.Set("host", scoped->request.remoteAddress);
		request.Set("port", scoped->request.remotePort);
		callback.Call({request});
	}

	const uint16_t port;
	const std::optional<std::string> address;
	bool active = true;
	bool tsfnReleased = false;
	mutable std::mutex lifecycleMutex;
	NativeDispatcher tsfn;
	std::unique_ptr<rtc::IceUdpMuxListener> iceUdpMuxListener;
};

void RegisterIceUdpMuxBinding(Napi::Env env, const std::shared_ptr<IceUdpMuxBinding> &binding) {
	auto &registry = env.GetInstanceData<EnvironmentState>()->listeners;
	registry.erase(std::remove_if(registry.begin(), registry.end(),
	                              [](const auto &entry) { return entry.expired(); }),
	               registry.end());
	registry.push_back(binding);
}

std::optional<uint16_t> ActiveIceUdpMuxPort(Napi::Env env) {
	auto &registry = env.GetInstanceData<EnvironmentState>()->listeners;
	std::optional<uint16_t> port;
	registry.erase(std::remove_if(registry.begin(), registry.end(),
	                              [&port](const auto &entry) {
		                              auto binding = entry.lock();
		                              if (!binding)
			                              return true;
		                              if (!binding->IsActive())
			                              return true;
		                              if (!port)
			                              port = binding->Port();
		                              return false;
	                              }),
	               registry.end());
	return port;
}

void CloseAllIceUdpMuxBindings(EnvironmentState *state) {
	auto entries = std::move(state->listeners);
	state->listeners.clear();
	for (auto &entry : entries) {
		if (auto binding = entry.lock())
			binding->Close();
	}
}

class NativeIceUdpMuxListener : public Napi::ObjectWrap<NativeIceUdpMuxListener> {
public:
	static void Init(Napi::Env env, Napi::Object exports) {
		Napi::Function func = DefineClass(
		    env, "NativeIceUdpMuxListener",
		    {
		        InstanceMethod("port", &NativeIceUdpMuxListener::Port),
		        InstanceMethod("address", &NativeIceUdpMuxListener::Address),
		        InstanceMethod("close", &NativeIceUdpMuxListener::Close),
		        InstanceMethod("stop", &NativeIceUdpMuxListener::Close),
		    });
		exports.Set("NativeIceUdpMuxListener", func);
	}

	NativeIceUdpMuxListener(const Napi::CallbackInfo &info)
	    : Napi::ObjectWrap<NativeIceUdpMuxListener>(info) {
		Napi::Env env = info.Env();
		if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction())
			throw Napi::TypeError::New(
			    env, "NativeIceUdpMuxListener requires a port and event callback");
		uint32_t port = info[0].ToNumber().Uint32Value();
		if (port > std::numeric_limits<uint16_t>::max())
			throw Napi::RangeError::New(env, "ICE UDP mux port must be between 0 and 65535");

		std::optional<std::string> address;
		if (info.Length() > 2 && !info[2].IsUndefined() && !info[2].IsNull()) {
			if (!info[2].IsString())
				throw Napi::TypeError::New(env, "ICE UDP mux address must be a string");
			address = info[2].ToString().Utf8Value();
		}

		try {
			binding_ = IceUdpMuxBinding::Create(env, info[1].As<Napi::Function>(),
			                                   static_cast<uint16_t>(port), std::move(address));
			RegisterIceUdpMuxBinding(env, binding_);
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
		}
	}

	~NativeIceUdpMuxListener() override {
		if (binding_)
			binding_->Close();
	}

private:
	std::shared_ptr<IceUdpMuxBinding> binding_;

	Napi::Value Port(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), binding_->Port());
	}

	Napi::Value Address(const Napi::CallbackInfo &info) {
		const auto &address = binding_->Address();
		if (!address)
			return info.Env().Undefined();
		return Napi::String::New(info.Env(), *address);
	}

	Napi::Value Close(const Napi::CallbackInfo &info) {
		binding_->Close();
		return info.Env().Undefined();
	}
};

struct ChannelBinding : public std::enable_shared_from_this<ChannelBinding> {
	using ClosedCallback = std::function<void(uint32_t, const ChannelBinding *)>;

	static std::shared_ptr<ChannelBinding> Create(std::shared_ptr<rtc::DataChannel> dataChannel,
	                                              std::shared_ptr<EventDispatcher> dispatcher,
	                                              std::shared_ptr<SendQueue> sendQueue,
	                                              std::shared_ptr<PeerSendHandoff> handoff,
	                                              ChannelOptions options,
	                                              ClosedCallback closedCallback) {
		auto binding = std::shared_ptr<ChannelBinding>(new ChannelBinding(
		    std::move(dataChannel), std::move(dispatcher), std::move(sendQueue), std::move(handoff),
		    std::move(options), std::move(closedCallback)));
		binding->AttachCallbacks();
		return binding;
	}

	static ChannelOptions IncomingOptions(const std::shared_ptr<rtc::DataChannel> &dataChannel) {
		ChannelOptions options;
		options.negotiated = false;
		options.protocol = dataChannel->protocol();
		rtc::Reliability reliability = dataChannel->reliability();
		options.ordered = !reliability.unordered;
		if (reliability.maxPacketLifeTime)
			options.maxPacketLifeTime =
			    static_cast<uint32_t>(reliability.maxPacketLifeTime->count());
		if (reliability.maxRetransmits)
			options.maxRetransmits = static_cast<uint32_t>(*reliability.maxRetransmits);
		return options;
	}

	template <typename Producer> bool Send(size_t size, Producer produce) {
		if (closeRequested.load() || sendsCancelled.load() || !handoff->Accepting() ||
		    !dataChannel->isOpen())
			throw std::runtime_error("DataChannel is not open");
		if (size > dataChannel->maxMessageSize())
			throw std::invalid_argument("Message size exceeds limit");
		sendQueue->EnqueueProduced(size, [&]() {
			auto send = std::make_shared<QueuedSend>(shared_from_this(), produce(), size);
			return [send]() { send->Run(); };
		});
		return true;
	}

	size_t BufferedAmount() const {
		// Read our backlog first: a handoff to SCTP must never expose a false zero.
		const size_t pending = pendingSendBytes.load();
		return pending + dataChannel->bufferedAmount();
	}

	void Close() {
		if (closeRequested.exchange(true) || !handoff->Accepting())
			return;
		sendQueue->Enqueue([dc = dataChannel]() {
			try {
				dc->close();
			} catch (...) {
			}
		}, 0, true);
	}

	void DeactivateCallbacks() {
		{
			std::lock_guard<std::mutex> lock(callbacksMutex);
			if (!callbacksActive)
				return;
			callbacksActive = false;
		}
		auto dc = dataChannel;
		if (dc)
			dc->resetCallbacks();
	}

	const uint32_t id;
	std::shared_ptr<rtc::DataChannel> dataChannel;
	std::shared_ptr<EventDispatcher> dispatcher;
	ChannelOptions options;

private:
	struct QueuedSend {
		std::shared_ptr<ChannelBinding> binding;
		PeerSendHandoff::Pending pending;
		rtc::message_variant data;
		size_t size;

		QueuedSend(std::shared_ptr<ChannelBinding> binding_, rtc::message_variant data_, size_t size_)
		    : binding(std::move(binding_)), pending(*binding->handoff), data(std::move(data_)),
		      size(size_) {
			binding->pendingSendBytes.fetch_add(size);
		}
		~QueuedSend() { binding->pendingSendBytes.fetch_sub(size); }

		void Run() {
			if (binding->sendsCancelled.load() || !binding->handoff->CanHandoff())
				return;
			try {
				// A false result means SCTP buffered the accepted message; never resend it.
				binding->dataChannel->send(std::move(data));
			} catch (const std::exception &error) {
				NativeEvent event;
				event.target = "datachannel";
				event.type = "error";
				event.channelId = binding->id;
				event.error = error.what();
				binding->Emit(std::move(event));
			}
		}
	};

	ChannelBinding(std::shared_ptr<rtc::DataChannel> dataChannel_,
	               std::shared_ptr<EventDispatcher> dispatcher_, std::shared_ptr<SendQueue> sendQueue_,
	               std::shared_ptr<PeerSendHandoff> handoff_,
	               ChannelOptions options_,
	               ClosedCallback closedCallback_)
	    : id(AllocateChannelId()), dataChannel(std::move(dataChannel_)),
	      dispatcher(std::move(dispatcher_)), options(std::move(options_)),
	      sendQueue(std::move(sendQueue_)), handoff(std::move(handoff_)),
	      closedCallback(std::move(closedCallback_)) {}

	void Emit(NativeEvent event) {
		std::lock_guard<std::mutex> lock(callbacksMutex);
		if (!callbacksActive)
			return;
		dispatcher->Emit(std::move(event));
	}

	void AttachCallbacks() {
		std::weak_ptr<ChannelBinding> weak = shared_from_this();

		dataChannel->onOpen([weak]() {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "datachannel";
				event.type = "open";
				event.channelId = self->id;
				self->Emit(std::move(event));
			}
		});

		dataChannel->onClosed([weak]() {
			if (auto self = weak.lock()) {
				self->sendsCancelled.store(true);
				NativeEvent event;
				event.target = "datachannel";
				event.type = "close";
				event.channelId = self->id;
				self->Emit(std::move(event));
				if (self->closedCallback)
					self->closedCallback(self->id, self.get());
			}
		});

		dataChannel->onError([weak](std::string error) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "datachannel";
				event.type = "error";
				event.channelId = self->id;
				event.error = std::move(error);
				self->Emit(std::move(event));
			}
		});

		dataChannel->onBufferedAmountLow([weak]() {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "datachannel";
				event.type = "bufferedamountlow";
				event.channelId = self->id;
				self->Emit(std::move(event));
			}
		});

		dataChannel->onMessage([weak](rtc::message_variant data) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "datachannel";
				event.type = "message";
				event.channelId = self->id;
				if (std::holds_alternative<std::string>(data)) {
					event.binary = false;
					event.text = std::get<std::string>(std::move(data));
				} else {
					event.binary = true;
					event.bytes = std::move(std::get<rtc::binary>(data));
				}
				self->Emit(std::move(event));
			}
		});
	}

	bool callbacksActive = true;
	std::shared_ptr<SendQueue> sendQueue;
	std::shared_ptr<PeerSendHandoff> handoff;
	std::atomic<size_t> pendingSendBytes{0};
	std::atomic<bool> closeRequested{false};
	std::atomic<bool> sendsCancelled{false};
	std::mutex callbacksMutex;
	ClosedCallback closedCallback;
};

class NativeDataChannel : public Napi::ObjectWrap<NativeDataChannel> {
public:
	static void Init(Napi::Env env, Napi::Object exports) {
		Napi::Function func = DefineClass(
		    env, "NativeDataChannel",
		    {
		        InstanceMethod("sendString", &NativeDataChannel::SendString),
		        InstanceMethod("sendBinary", &NativeDataChannel::SendBinary),
		        InstanceMethod("close", &NativeDataChannel::Close),
		        InstanceMethod("setBufferedAmountLowThreshold",
		                       &NativeDataChannel::SetBufferedAmountLowThreshold),
		        InstanceAccessor("bindingId", &NativeDataChannel::GetBindingId, nullptr),
		        InstanceAccessor("id", &NativeDataChannel::GetId, nullptr),
		        InstanceAccessor("label", &NativeDataChannel::GetLabel, nullptr),
		        InstanceAccessor("protocol", &NativeDataChannel::GetProtocol, nullptr),
		        InstanceAccessor("ordered", &NativeDataChannel::GetOrdered, nullptr),
		        InstanceAccessor("negotiated", &NativeDataChannel::GetNegotiated, nullptr),
		        InstanceAccessor("maxPacketLifeTime", &NativeDataChannel::GetMaxPacketLifeTime,
		                         nullptr),
		        InstanceAccessor("maxRetransmits", &NativeDataChannel::GetMaxRetransmits, nullptr),
		        InstanceAccessor("bufferedAmount", &NativeDataChannel::GetBufferedAmount, nullptr),
		        InstanceAccessor("isOpen", &NativeDataChannel::GetIsOpen, nullptr),
		        InstanceAccessor("isClosed", &NativeDataChannel::GetIsClosed, nullptr),
		        InstanceAccessor("maxMessageSize", &NativeDataChannel::GetMaxMessageSize, nullptr),
		    });
		env.GetInstanceData<EnvironmentState>()->dataChannelConstructor = Napi::Persistent(func);
		exports.Set("NativeDataChannel", func);
	}

	static Napi::Object NewInstance(Napi::Env env, std::shared_ptr<ChannelBinding> binding) {
		auto *payload = new std::shared_ptr<ChannelBinding>(std::move(binding));
		auto external = Napi::External<std::shared_ptr<ChannelBinding>>::New(
		    env, payload, [](Napi::Env, std::shared_ptr<ChannelBinding> *data) { delete data; });
		return env.GetInstanceData<EnvironmentState>()->dataChannelConstructor.New({external});
	}

	NativeDataChannel(const Napi::CallbackInfo &info) : Napi::ObjectWrap<NativeDataChannel>(info) {
		if (!info[0].IsExternal())
			throw Napi::TypeError::New(info.Env(), "NativeDataChannel requires a native binding");
		binding_ = *info[0].As<Napi::External<std::shared_ptr<ChannelBinding>>>().Data();
	}

private:
	std::shared_ptr<ChannelBinding> binding_;

	Napi::Value SendString(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			Napi::String value = info[0].ToString();
			size_t size;
			if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok)
				throw Napi::Error::New(env);
			bool sent = binding_->Send(size, [&]() {
				std::string data(size, '\0');
				if (napi_get_value_string_utf8(env, value, data.data(), size + 1, nullptr) != napi_ok)
					throw Napi::Error::New(env);
				return rtc::message_variant(std::move(data));
			});
			return Napi::Boolean::New(env, sent);
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value SendBinary(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			if (!info[0].IsTypedArray())
				throw std::invalid_argument("sendBinary expects a Uint8Array");
			auto view = info[0].As<Napi::Uint8Array>();
			const auto *bytes = reinterpret_cast<const rtc::byte *>(view.Data());
			const size_t size = view.ByteLength();
			bool sent = binding_->Send(size, [&]() {
				rtc::binary data(size);
				if (!data.empty())
					std::memcpy(data.data(), bytes, data.size());
				return rtc::message_variant(std::move(data));
			});
			return Napi::Boolean::New(env, sent);
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value Close(const Napi::CallbackInfo &info) {
		try {
			binding_->Close();
		} catch (const std::exception &e) {
			Napi::Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
		}
		return info.Env().Undefined();
	}

	Napi::Value SetBufferedAmountLowThreshold(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			size_t value = info[0].ToNumber().Uint32Value();
			binding_->dataChannel->setBufferedAmountLowThreshold(value);
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
		}
		return env.Undefined();
	}

	Napi::Value GetBindingId(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), binding_->id);
	}

	Napi::Value GetId(const Napi::CallbackInfo &info) {
		auto id = binding_->dataChannel->id();
		if (!id)
			return info.Env().Null();
		return Napi::Number::New(info.Env(), *id);
	}

	Napi::Value GetLabel(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), binding_->dataChannel->label());
	}

	Napi::Value GetProtocol(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), binding_->dataChannel->protocol());
	}

	Napi::Value GetOrdered(const Napi::CallbackInfo &info) {
		return Napi::Boolean::New(info.Env(), binding_->options.ordered);
	}

	Napi::Value GetNegotiated(const Napi::CallbackInfo &info) {
		return Napi::Boolean::New(info.Env(), binding_->options.negotiated);
	}

	Napi::Value GetMaxPacketLifeTime(const Napi::CallbackInfo &info) {
		if (!binding_->options.maxPacketLifeTime)
			return info.Env().Null();
		return Napi::Number::New(info.Env(), *binding_->options.maxPacketLifeTime);
	}

	Napi::Value GetMaxRetransmits(const Napi::CallbackInfo &info) {
		if (!binding_->options.maxRetransmits)
			return info.Env().Null();
		return Napi::Number::New(info.Env(), *binding_->options.maxRetransmits);
	}

	Napi::Value GetBufferedAmount(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), binding_->BufferedAmount());
	}

	Napi::Value GetIsOpen(const Napi::CallbackInfo &info) {
		return Napi::Boolean::New(info.Env(), binding_->dataChannel->isOpen());
	}

	Napi::Value GetIsClosed(const Napi::CallbackInfo &info) {
		return Napi::Boolean::New(info.Env(), binding_->dataChannel->isClosed());
	}

	Napi::Value GetMaxMessageSize(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), binding_->dataChannel->maxMessageSize());
	}
};

Napi::Object EventDispatcher::EventToObject(Napi::Env env, NativeEvent &event) {
	Napi::Object object = Napi::Object::New(env);
	object.Set("target", event.target);
	object.Set("type", event.type);
	if (event.channelId)
		object.Set("channelId", event.channelId);
	if (!event.state.empty())
		object.Set("state", event.state);
	if (!event.descriptionType.empty()) {
		Napi::Object description = Napi::Object::New(env);
		description.Set("type", event.descriptionType);
		description.Set("sdp", event.sdp);
		object.Set("description", description);
	}
	if (!event.candidate.empty() || !event.mid.empty()) {
		Napi::Object candidate = Napi::Object::New(env);
		candidate.Set("candidate", event.candidate);
		if (!event.mid.empty())
			candidate.Set("sdpMid", event.mid);
		object.Set("candidate", candidate);
	}
	if (!event.error.empty())
		object.Set("error", event.error);
	if (event.type == "message") {
		object.Set("binary", event.binary);
		object.Set("data", MessagePayloadToValue(env, event));
	}
	if (event.channel) {
		object.Set("channel", NativeDataChannel::NewInstance(env, event.channel));
		object.Set("channelId", event.channel->id);
		object.Set("channelReadyState", "open");
	}

	return object;
}

Napi::Object CandidateToObject(Napi::Env env, const rtc::Candidate &candidate) {
	Napi::Object object = Napi::Object::New(env);
	object.Set("candidate", candidate.candidate());
	object.Set("sdpMid", candidate.mid());
	return object;
}

void AppendIceServer(rtc::Configuration &config, const Napi::Object &server,
                     const Napi::Value &urlValue) {
	if (!urlValue.IsString())
		return;

	rtc::IceServer iceServer(urlValue.ToString().Utf8Value());
	if (iceServer.type == rtc::IceServer::Type::Turn) {
		if (server.Has("username") && server.Get("username").IsString())
			iceServer.username = server.Get("username").ToString().Utf8Value();
		if (server.Has("credential") && server.Get("credential").IsString())
			iceServer.password = server.Get("credential").ToString().Utf8Value();
	}
	config.iceServers.push_back(std::move(iceServer));
}

rtc::Configuration ParseConfiguration(const Napi::CallbackInfo &info) {
	rtc::Configuration config;
	config.disableAutoNegotiation = true;
	config.disableAutoGathering = true;

	if (info.Length() == 0 || !info[0].IsObject())
		return config;

	Napi::Object input = info[0].As<Napi::Object>();
	if (input.Has("iceTransportPolicy")) {
		std::string policy = input.Get("iceTransportPolicy").ToString().Utf8Value();
		if (policy == "relay")
			config.iceTransportPolicy = rtc::TransportPolicy::Relay;
	}
	if (input.Has("enableIceUdpMux") && input.Get("enableIceUdpMux").IsBoolean())
		config.enableIceUdpMux = input.Get("enableIceUdpMux").ToBoolean().Value();
	if (config.enableIceUdpMux) {
		if (auto port = ActiveIceUdpMuxPort(info.Env())) {
			config.portRangeBegin = *port;
			config.portRangeEnd = *port;
		}
	}
	if (input.Has("disableFingerprintVerification") &&
	    input.Get("disableFingerprintVerification").IsBoolean())
		config.disableFingerprintVerification =
		    input.Get("disableFingerprintVerification").ToBoolean().Value();
	if (input.Has("maxMessageSize") && !input.Get("maxMessageSize").IsUndefined() &&
	    !input.Get("maxMessageSize").IsNull()) {
		double value = input.Get("maxMessageSize").ToNumber().DoubleValue();
		if (!std::isfinite(value) || value < 0 || std::floor(value) != value ||
		    value > static_cast<double>(std::numeric_limits<size_t>::max()))
			throw std::invalid_argument("maxMessageSize must be a non-negative integer");
		config.maxMessageSize = static_cast<size_t>(value);
	}
	if (input.Has("iceServers") && input.Get("iceServers").IsArray()) {
		Napi::Array servers = input.Get("iceServers").As<Napi::Array>();
		for (uint32_t i = 0; i < servers.Length(); ++i) {
			Napi::Value value = servers.Get(i);
			if (!value.IsObject())
				continue;
			Napi::Object server = value.As<Napi::Object>();
			if (!server.Has("urls"))
				continue;
			Napi::Value urls = server.Get("urls");
			if (urls.IsArray()) {
				Napi::Array urlArray = urls.As<Napi::Array>();
				for (uint32_t j = 0; j < urlArray.Length(); ++j) {
					AppendIceServer(config, server, urlArray.Get(j));
				}
			} else if (urls.IsString()) {
				AppendIceServer(config, server, urls);
			}
		}
	}
	if (input.Has("certificatePem") && input.Has("keyPem") &&
	    input.Get("certificatePem").IsString() && input.Get("keyPem").IsString()) {
		config.certificatePemFile = input.Get("certificatePem").ToString().Utf8Value();
		config.keyPemFile = input.Get("keyPem").ToString().Utf8Value();
	} else if (input.Has("certificates") && input.Get("certificates").IsArray()) {
		Napi::Array certificates = input.Get("certificates").As<Napi::Array>();
		if (certificates.Length() > 0 && certificates.Get(uint32_t{0}).IsObject()) {
			Napi::Object certificate = certificates.Get(uint32_t{0}).As<Napi::Object>();
			if (certificate.Has("_certificatePem") && certificate.Has("_keyPem") &&
			    certificate.Get("_certificatePem").IsString() &&
			    certificate.Get("_keyPem").IsString()) {
				config.certificatePemFile = certificate.Get("_certificatePem").ToString().Utf8Value();
				config.keyPemFile = certificate.Get("_keyPem").ToString().Utf8Value();
			}
		}
	}

	return config;
}

ChannelOptions ParseChannelOptions(const Napi::Value &value) {
	ChannelOptions options;
	if (!value.IsObject())
		return options;

	Napi::Object input = value.As<Napi::Object>();
	if (input.Has("ordered") && input.Get("ordered").IsBoolean())
		options.ordered = input.Get("ordered").ToBoolean().Value();
	if (input.Has("negotiated") && input.Get("negotiated").IsBoolean())
		options.negotiated = input.Get("negotiated").ToBoolean().Value();
	if (input.Has("protocol") && !input.Get("protocol").IsUndefined() &&
	    !input.Get("protocol").IsNull())
		options.protocol = input.Get("protocol").ToString().Utf8Value();
	if (input.Has("id") && !input.Get("id").IsUndefined() && !input.Get("id").IsNull())
		options.id = static_cast<uint16_t>(input.Get("id").ToNumber().Uint32Value());
	if (input.Has("maxPacketLifeTime") && !input.Get("maxPacketLifeTime").IsUndefined() &&
	    !input.Get("maxPacketLifeTime").IsNull())
		options.maxPacketLifeTime = input.Get("maxPacketLifeTime").ToNumber().Uint32Value();
	if (input.Has("maxRetransmits") && !input.Get("maxRetransmits").IsUndefined() &&
	    !input.Get("maxRetransmits").IsNull())
		options.maxRetransmits = input.Get("maxRetransmits").ToNumber().Uint32Value();
	if (options.maxPacketLifeTime && options.maxRetransmits)
		throw std::invalid_argument("maxPacketLifeTime and maxRetransmits are mutually exclusive");
	return options;
}

rtc::DataChannelInit ToRtcInit(const ChannelOptions &options) {
	rtc::DataChannelInit init;
	init.negotiated = options.negotiated;
	init.protocol = options.protocol;
	if (options.id)
		init.id = *options.id;
	init.reliability.unordered = !options.ordered;
	if (options.maxPacketLifeTime)
		init.reliability.maxPacketLifeTime = std::chrono::milliseconds(*options.maxPacketLifeTime);
	if (options.maxRetransmits)
		init.reliability.maxRetransmits = *options.maxRetransmits;
	return init;
}

struct PeerBinding : public std::enable_shared_from_this<PeerBinding> {
	static std::shared_ptr<PeerBinding> Create(rtc::Configuration config,
	                                           std::shared_ptr<EventDispatcher> dispatcher,
	                                           std::shared_ptr<SendQueue> sendQueue,
	                                           std::shared_ptr<TeardownTasks> teardownTasks) {
		auto binding =
		    std::shared_ptr<PeerBinding>(new PeerBinding(
		        std::move(config), std::move(dispatcher), std::move(sendQueue),
		        std::move(teardownTasks)));
		binding->AttachCallbacks();
		return binding;
	}

	std::shared_ptr<ChannelBinding> AddChannel(std::shared_ptr<rtc::DataChannel> dataChannel,
	                                           ChannelOptions options) {
		if (shutdown.load()) {
			CloseDataChannelForTeardown(dataChannel);
			return nullptr;
		}
		std::weak_ptr<PeerBinding> weak = shared_from_this();
		auto channel = ChannelBinding::Create(
		    std::move(dataChannel), dispatcher, sendQueue, handoff, std::move(options),
		    [weak](uint32_t id, const ChannelBinding *expected) {
			    if (auto self = weak.lock())
				    self->RemoveChannel(id, expected);
		    });
		bool closeChannel = false;
		{
			std::lock_guard<std::mutex> lock(channelsMutex);
			if (shutdown.load())
				closeChannel = true;
			else
				channels[channel->id] = channel;
		}
		if (closeChannel) {
			channel->DeactivateCallbacks();
			CloseDataChannelForTeardown(channel->dataChannel);
			return nullptr;
		}
		if (channel->dataChannel->isClosed())
			RemoveChannel(channel->id, channel.get());
		return channel;
	}

	void ClosePeer() { ScheduleShutdown(PEER_CLOSE_HANDOFF_GRACE); }

	void Destroy() { ScheduleShutdown(std::chrono::steady_clock::duration::zero()); }

	void DestroySync() {
		auto work = PrepareShutdown(std::chrono::steady_clock::duration::zero());
		if (work)
			RunPeerTeardown(std::move(*work));
	}

	std::shared_ptr<rtc::PeerConnection> peerConnection;
	std::shared_ptr<EventDispatcher> dispatcher;

private:
	PeerBinding(rtc::Configuration config, std::shared_ptr<EventDispatcher> dispatcher_,
	            std::shared_ptr<SendQueue> sendQueue_, std::shared_ptr<TeardownTasks> teardownTasks_)
	    : peerConnection(std::make_shared<rtc::PeerConnection>(std::move(config))),
	      dispatcher(std::move(dispatcher_)), sendQueue(std::move(sendQueue_)),
	      teardownTasks(std::move(teardownTasks_)) {}

	void Emit(NativeEvent event) {
		std::lock_guard<std::mutex> lock(callbacksMutex);
		if (!callbacksActive)
			return;
		dispatcher->Emit(std::move(event));
	}

	void DeactivateCallbacks() {
		{
			std::lock_guard<std::mutex> lock(callbacksMutex);
			if (!callbacksActive)
				return;
			callbacksActive = false;
		}
		if (peerConnection)
			peerConnection->resetCallbacks();
	}

	void RemoveChannel(uint32_t id, const ChannelBinding *expected) {
		std::lock_guard<std::mutex> lock(channelsMutex);
		auto found = channels.find(id);
		if (found != channels.end() && found->second.get() == expected)
			channels.erase(found);
	}

	std::optional<PeerTeardownWork> PrepareShutdown(std::chrono::steady_clock::duration grace) {
		if (shutdown.exchange(true))
			return std::nullopt;
		handoff->Close(grace);

		std::vector<std::shared_ptr<ChannelBinding>> channelSnapshot;
		{
			std::lock_guard<std::mutex> lock(channelsMutex);
			channelSnapshot.reserve(channels.size());
			for (auto &[_, channel] : channels)
				channelSnapshot.push_back(channel);
			channels.clear();
		}

		PeerTeardownWork work;
		work.dataChannels.reserve(channelSnapshot.size());
		for (auto &channel : channelSnapshot) {
			channel->DeactivateCallbacks();
			if (channel->dataChannel)
				work.dataChannels.push_back(channel->dataChannel);
		}
		DeactivateCallbacks();
		dispatcher->Close();
		work.peerConnection = std::move(peerConnection);
		return work;
	}

	void ScheduleShutdown(std::chrono::steady_clock::duration grace) {
		auto work = PrepareShutdown(grace);
		if (!work)
			return;

		teardownTasks->Start([work = std::move(*work), handoff = handoff]() mutable {
			handoff->WaitForHandoff();
			RunPeerTeardown(std::move(work));
		});
	}

	void AttachCallbacks() {
		std::weak_ptr<PeerBinding> weak = shared_from_this();

		peerConnection->onLocalDescription([weak](rtc::Description description) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "peerconnection";
				event.type = "localdescription";
				event.descriptionType = description.typeString();
				event.sdp = std::string(description);
				self->Emit(std::move(event));
			}
		});

		peerConnection->onLocalCandidate([weak](rtc::Candidate candidate) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "peerconnection";
				event.type = "localcandidate";
				event.candidate = candidate.candidate();
				event.mid = candidate.mid();
				self->Emit(std::move(event));
			}
		});

		peerConnection->onStateChange([weak](rtc::PeerConnection::State state) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "peerconnection";
				event.type = "connectionstatechange";
				event.state = ToString(state);
				self->Emit(std::move(event));
			}
		});

		peerConnection->onIceStateChange([weak](rtc::PeerConnection::IceState state) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "peerconnection";
				event.type = "iceconnectionstatechange";
				event.state = ToString(state);
				self->Emit(std::move(event));
			}
		});

		peerConnection->onGatheringStateChange([weak](rtc::PeerConnection::GatheringState state) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "peerconnection";
				event.type = "icegatheringstatechange";
				event.state = ToString(state);
				self->Emit(std::move(event));
			}
		});

		peerConnection->onSignalingStateChange([weak](rtc::PeerConnection::SignalingState state) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "peerconnection";
				event.type = "signalingstatechange";
				event.state = ToString(state);
				self->Emit(std::move(event));
			}
		});

		peerConnection->onDataChannel([weak](std::shared_ptr<rtc::DataChannel> dataChannel) {
			if (auto self = weak.lock()) {
				auto channel =
				    self->AddChannel(dataChannel, ChannelBinding::IncomingOptions(dataChannel));
				if (!channel)
					return;
				NativeEvent event;
				event.target = "peerconnection";
				event.type = "datachannel";
				event.channelId = channel->id;
				event.channel = std::move(channel);
				self->Emit(std::move(event));
			}
		});
	}

	std::atomic<bool> shutdown{false};
	std::shared_ptr<SendQueue> sendQueue;
	std::shared_ptr<PeerSendHandoff> handoff = std::make_shared<PeerSendHandoff>();
	std::shared_ptr<TeardownTasks> teardownTasks;
	bool callbacksActive = true;
	std::mutex callbacksMutex;
	std::mutex channelsMutex;
	std::unordered_map<uint32_t, std::shared_ptr<ChannelBinding>> channels;
};

void RegisterPeerBinding(Napi::Env env, const std::shared_ptr<PeerBinding> &binding) {
	auto &registry = env.GetInstanceData<EnvironmentState>()->peers;
	registry.erase(std::remove_if(registry.begin(), registry.end(),
	                              [](const auto &entry) { return entry.expired(); }),
	               registry.end());
	registry.push_back(binding);
}

void CloseAllPeerBindings(EnvironmentState *state) {
	auto entries = std::move(state->peers);
	state->peers.clear();
	for (auto &entry : entries) {
		if (auto binding = entry.lock())
			binding->DestroySync();
	}
}

class NativePeerConnection : public Napi::ObjectWrap<NativePeerConnection> {
public:
	static void Init(Napi::Env env, Napi::Object exports) {
		Napi::Function func = DefineClass(
		    env, "NativePeerConnection",
		    {
		        InstanceMethod("createDataChannel", &NativePeerConnection::CreateDataChannel),
		        InstanceMethod("createOffer", &NativePeerConnection::CreateOffer),
		        InstanceMethod("createAnswer", &NativePeerConnection::CreateAnswer),
		        InstanceMethod("setLocalDescription", &NativePeerConnection::SetLocalDescription),
		        InstanceMethod("setRemoteDescription", &NativePeerConnection::SetRemoteDescription),
		        InstanceMethod("addRemoteCandidate", &NativePeerConnection::AddRemoteCandidate),
		        InstanceMethod("gatherLocalCandidates", &NativePeerConnection::GatherLocalCandidates),
		        InstanceMethod("localDescription", &NativePeerConnection::LocalDescription),
		        InstanceMethod("remoteDescription", &NativePeerConnection::RemoteDescription),
		        InstanceMethod("remoteFingerprint", &NativePeerConnection::RemoteFingerprint),
		        InstanceMethod("selectedCandidatePair", &NativePeerConnection::SelectedCandidatePair),
		        InstanceMethod("close", &NativePeerConnection::Close),
		        InstanceAccessor("connectionState", &NativePeerConnection::GetConnectionState, nullptr),
		        InstanceAccessor("iceConnectionState", &NativePeerConnection::GetIceConnectionState,
		                         nullptr),
		        InstanceAccessor("iceGatheringState", &NativePeerConnection::GetIceGatheringState,
		                         nullptr),
		        InstanceAccessor("signalingState", &NativePeerConnection::GetSignalingState, nullptr),
		        InstanceAccessor("remoteMaxMessageSize",
		                         &NativePeerConnection::GetRemoteMaxMessageSize, nullptr),
		        InstanceAccessor("maxDataChannelId", &NativePeerConnection::GetMaxDataChannelId,
		                         nullptr),
		    });
		exports.Set("NativePeerConnection", func);
	}

	NativePeerConnection(const Napi::CallbackInfo &info)
	    : Napi::ObjectWrap<NativePeerConnection>(info) {
		Napi::Env env = info.Env();
		if (info.Length() < 2 || !info[1].IsFunction())
			throw Napi::TypeError::New(env, "NativePeerConnection requires an event callback");
		try {
			auto dispatcher = EventDispatcher::Create(env, info[1].As<Napi::Function>());
			binding_ = PeerBinding::Create(ParseConfiguration(info), dispatcher,
			                             env.GetInstanceData<EnvironmentState>()->sendQueue,
			                             env.GetInstanceData<EnvironmentState>()->teardownTasks);
			RegisterPeerBinding(env, binding_);
		} catch (const Napi::Error &) {
			throw;
		} catch (const std::exception &error) {
			throw Napi::Error::New(env, error.what());
		}
	}

	~NativePeerConnection() override {
		if (binding_)
			binding_->Destroy();
	}

private:
	std::shared_ptr<PeerBinding> binding_;

	std::shared_ptr<rtc::PeerConnection> RequirePeer(Napi::Env env) const {
		if (!binding_ || !binding_->peerConnection)
			throw Napi::Error::New(env, "Native peer connection is closed");
		return binding_->peerConnection;
	}

	Napi::Value CreateDataChannel(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			std::string label = info[0].ToString().Utf8Value();
			ChannelOptions options =
			    ParseChannelOptions(info.Length() > 1 ? info[1] : env.Undefined());
			auto dataChannel =
			    RequirePeer(info.Env())->createDataChannel(label, ToRtcInit(options));
			auto channel = binding_->AddChannel(std::move(dataChannel), std::move(options));
			return NativeDataChannel::NewInstance(env, std::move(channel));
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value CreateOffer(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			return DescriptionToObject(env, RequirePeer(info.Env())->createOffer());
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value CreateAnswer(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			return DescriptionToObject(env, RequirePeer(info.Env())->createAnswer());
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value SetLocalDescription(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			std::string type;
			if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull())
				type = info[0].ToString().Utf8Value();
			rtc::LocalDescriptionInit init;
			if (info.Length() > 1)
				init = ParseLocalDescriptionInit(info[1]);
			RequirePeer(info.Env())->setLocalDescription(ParseDescriptionType(type), init);
			return env.Undefined();
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value SetRemoteDescription(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			Napi::Object object = info[0].As<Napi::Object>();
			std::string type = object.Get("type").ToString().Utf8Value();
			std::string sdp = object.Get("sdp").ToString().Utf8Value();
			RequirePeer(info.Env())->setRemoteDescription(rtc::Description(sdp, type));
			return env.Undefined();
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value AddRemoteCandidate(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			Napi::Object object = info[0].As<Napi::Object>();
			std::string candidate = object.Get("candidate").ToString().Utf8Value();
			std::string mid;
			if (object.Has("sdpMid") && !object.Get("sdpMid").IsNull() &&
			    !object.Get("sdpMid").IsUndefined())
				mid = object.Get("sdpMid").ToString().Utf8Value();
			RequirePeer(info.Env())->addRemoteCandidate(rtc::Candidate(candidate, mid));
			return env.Undefined();
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value GatherLocalCandidates(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			RequirePeer(info.Env())->gatherLocalCandidates();
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
		}
		return env.Undefined();
	}

	Napi::Value LocalDescription(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			auto description = RequirePeer(info.Env())->localDescription();
			if (!description)
				return env.Null();
			return DescriptionToObject(env, *description);
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value RemoteDescription(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			auto description = RequirePeer(info.Env())->remoteDescription();
			if (!description)
				return env.Null();
			return DescriptionToObject(env, *description);
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value RemoteFingerprint(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			auto fingerprint = RequirePeer(info.Env())->remoteFingerprint();
			if (!fingerprint.isValid())
				return env.Null();
			Napi::Object result = Napi::Object::New(env);
			result.Set("algorithm",
			           rtc::CertificateFingerprint::AlgorithmIdentifier(fingerprint.algorithm));
			result.Set("value", fingerprint.value);
			return result;
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value SelectedCandidatePair(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			rtc::Candidate local;
			rtc::Candidate remote;
			if (!RequirePeer(info.Env())->getSelectedCandidatePair(&local, &remote))
				return env.Null();
			Napi::Object pair = Napi::Object::New(env);
			pair.Set("local", CandidateToObject(env, local));
			pair.Set("remote", CandidateToObject(env, remote));
			return pair;
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value Close(const Napi::CallbackInfo &info) {
		try {
			binding_->ClosePeer();
		} catch (const std::exception &e) {
			Napi::Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
		}
		return info.Env().Undefined();
	}

	Napi::Value GetConnectionState(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), ToString(RequirePeer(info.Env())->state()));
	}

	Napi::Value GetIceConnectionState(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), ToString(RequirePeer(info.Env())->iceState()));
	}

	Napi::Value GetIceGatheringState(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), ToString(RequirePeer(info.Env())->gatheringState()));
	}

	Napi::Value GetSignalingState(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), ToString(RequirePeer(info.Env())->signalingState()));
	}

	Napi::Value GetRemoteMaxMessageSize(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), RequirePeer(info.Env())->remoteMaxMessageSize());
	}

	Napi::Value GetMaxDataChannelId(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), RequirePeer(info.Env())->maxDataChannelId());
	}
};

Napi::Value GenerateCertificate(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	try {
		if (info.Length() == 0 || !info[0].IsObject())
			throw std::invalid_argument("generateCertificate requires an options object");
		Napi::Object options = info[0].As<Napi::Object>();
		std::string algorithm = options.Get("algorithm").ToString().Utf8Value();
		uint32_t modulusLength = options.Has("modulusLength")
		                             ? options.Get("modulusLength").ToNumber().Uint32Value()
		                             : 2048;
		double expiresMs =
		    options.Has("expiresMs") ? options.Get("expiresMs").ToNumber().DoubleValue()
		                             : 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;

		auto material =
		    webrtc_node::GenerateCertificateMaterial(algorithm, modulusLength, expiresMs);
		Napi::Object result = Napi::Object::New(env);
		result.Set("certificatePem", material.certificatePem);
		result.Set("keyPem", material.keyPem);
		Napi::Array fingerprints = Napi::Array::New(env, 1);
		Napi::Object fingerprint = Napi::Object::New(env);
		fingerprint.Set("algorithm", "sha-256");
		fingerprint.Set("value", material.fingerprint);
		fingerprints.Set(uint32_t{0}, fingerprint);
		result.Set("fingerprints", fingerprints);
		return result;
	} catch (const std::exception &e) {
		Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
		return env.Undefined();
	}
}

Napi::Value ImportCertificate(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	try {
		if (info.Length() == 0 || !info[0].IsObject())
			throw std::invalid_argument("importCertificate requires an options object");
		Napi::Object options = info[0].As<Napi::Object>();
		if (!options.Has("certificatePem") || !options.Get("certificatePem").IsString())
			throw std::invalid_argument("certificatePem must be a string");
		if (!options.Has("keyPem") || !options.Get("keyPem").IsString())
			throw std::invalid_argument("keyPem must be a string");

		auto material = webrtc_node::ImportCertificateMaterial(
		    options.Get("certificatePem").ToString().Utf8Value(),
		    options.Get("keyPem").ToString().Utf8Value());
		Napi::Object result = Napi::Object::New(env);
		result.Set("certificatePem", material.certificatePem);
		result.Set("keyPem", material.keyPem);
		result.Set("expires", material.expires);
		Napi::Array fingerprints = Napi::Array::New(env, 1);
		Napi::Object fingerprint = Napi::Object::New(env);
		fingerprint.Set("algorithm", "sha-256");
		fingerprint.Set("value", material.fingerprint);
		fingerprints.Set(uint32_t{0}, fingerprint);
		result.Set("fingerprints", fingerprints);
		return result;
	} catch (const std::exception &e) {
		Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
		return env.Undefined();
	}
}

void ConfigureLibDataChannelLogging() {
	const char *value = std::getenv("WEBRTC_NODE_LIBDATACHANNEL_LOG");
	if (!value)
		return;

	std::string level(value);
	if (level == "verbose")
		rtc::InitLogger(rtc::LogLevel::Verbose);
	else if (level == "debug")
		rtc::InitLogger(rtc::LogLevel::Debug);
	else if (level == "info")
		rtc::InitLogger(rtc::LogLevel::Info);
	else if (level == "warning")
		rtc::InitLogger(rtc::LogLevel::Warning);
	else if (level == "error")
		rtc::InitLogger(rtc::LogLevel::Error);
}

bool ConfigureLibDataChannelThreadLimit(Napi::Env env) {
	const char *value = std::getenv("WEBRTC_NODE_LIBDATACHANNEL_THREAD_LIMIT");
	if (!value)
		return true;
	const char *end = value + std::strlen(value);
	unsigned int limit = 0;
	const auto result = std::from_chars(value, end, limit);
	if (result.ec != std::errc() || result.ptr != end || limit < 2) {
		Napi::RangeError::New(
		    env, "WEBRTC_NODE_LIBDATACHANNEL_THREAD_LIMIT must be an integer from 2 to 4294967295")
		    .ThrowAsJavaScriptException();
		return false;
	}

	const auto automatic = std::max(2u, std::thread::hardware_concurrency());
	rtc::SetThreadPoolSize(std::min(limit, automatic));
	return true;
}

void CleanupNative(EnvironmentState *state) {
	CloseAllPeerBindings(state);
	CloseAllIceUdpMuxBindings(state);
	state->teardownTasks->Join();
}

void CleanupEnvironment(EnvironmentState *state) {
	state->sendQueue->Stop();
	CleanupNative(state);
	state->dataChannelConstructor.Reset();
	std::lock_guard lock(environmentMutex);
	if (--environmentCount == 0)
		rtc::Cleanup().wait();
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
	std::lock_guard lock(environmentMutex);
	static bool configured = false;
	if (!configured) {
		if (!ConfigureLibDataChannelThreadLimit(env))
			return Napi::Object();
		ConfigureLibDataChannelLogging();
		configured = true;
	}
	auto *state = new EnvironmentState();
	env.SetInstanceData(state);
	NativeDataChannel::Init(env, exports);
	NativeIceUdpMuxListener::Init(env, exports);
	NativePeerConnection::Init(env, exports);
	exports.Set("generateCertificate", Napi::Function::New(env, GenerateCertificate));
	exports.Set("importCertificate", Napi::Function::New(env, ImportCertificate));
	++environmentCount;
	state->cleanupHook = env.AddCleanupHook(CleanupEnvironment, state);
	exports.Set("cleanup", Napi::Function::New(env, [](const Napi::CallbackInfo &info) {
		            CleanupNative(info.Env().GetInstanceData<EnvironmentState>());
		            return info.Env().Undefined();
	            }));
	return exports;
}

} // namespace

NODE_API_MODULE(webrtc_node, InitAll)
