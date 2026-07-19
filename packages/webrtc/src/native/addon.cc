#include <napi.h>
#include <rtc/rtc.hpp>

#include "certificate.hpp"

#include <algorithm>
#include <atomic>
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
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

class NativeDataChannel;
class NativeIceUdpMuxListener;
class NativeTrack;
struct ChannelBinding;
struct EventDispatcher;
struct IceUdpMuxBinding;
struct PeerBinding;
struct TrackBinding;

std::atomic<uint32_t> nextChannelId{1};
std::atomic<uint32_t> nextTrackId{1};
constexpr auto PEER_CLOSE_TIMEOUT = std::chrono::seconds(5);
constexpr size_t MAX_PENDING_TRACK_PACKETS = 1024;
constexpr int MID_HEADER_EXTENSION_ID = 1;
constexpr auto MID_HEADER_EXTENSION_URI = "urn:ietf:params:rtp-hdrext:sdes:mid";

bool IsRtpPacket(const rtc::byte *data, size_t size) {
	if (size < 2 || (static_cast<uint8_t>(data[0]) >> 6) != 2)
		return false;
	const auto payloadType = static_cast<uint8_t>(data[1]);
	return payloadType < 192 || payloadType > 223;
}

uint32_t AllocateChannelId() {
	uint32_t id;
	do {
		id = nextChannelId.fetch_add(1, std::memory_order_relaxed);
	} while (id == 0);
	return id;
}

uint32_t AllocateTrackId() {
	uint32_t id;
	do {
		id = nextTrackId.fetch_add(1, std::memory_order_relaxed);
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

rtc::Description::Direction ParseMediaDirection(const std::string &direction) {
	if (direction == "sendonly")
		return rtc::Description::Direction::SendOnly;
	if (direction == "recvonly")
		return rtc::Description::Direction::RecvOnly;
	if (direction == "sendrecv")
		return rtc::Description::Direction::SendRecv;
	if (direction == "inactive")
		return rtc::Description::Direction::Inactive;
	throw std::invalid_argument("direction must be sendonly, recvonly, sendrecv, or inactive");
}

std::vector<std::string> ParseStringArray(const Napi::Value &value, const char *name) {
	if (!value.IsArray())
		throw std::invalid_argument(std::string(name) + " must be an array");
	Napi::Array input = value.As<Napi::Array>();
	std::vector<std::string> values;
	values.reserve(input.Length());
	for (uint32_t i = 0; i < input.Length(); ++i) {
		if (!input.Get(i).IsString())
			throw std::invalid_argument(std::string(name) + " entries must be strings");
		auto entry = input.Get(i).ToString().Utf8Value();
		if (entry.empty() || entry.find_first_of(" \t\r\n") != std::string::npos)
			throw std::invalid_argument(std::string(name) + " entries must be non-empty SDP tokens");
		values.push_back(std::move(entry));
	}
	return values;
}

void SetMediaStreamIds(rtc::Description::Media &media,
	                   const std::vector<std::string> &streamIds,
	                   const std::optional<std::string> &trackId) {
	for (const auto &attribute : media.attributes()) {
		if (attribute.rfind("msid:", 0) == 0 ||
		    (attribute.rfind("ssrc:", 0) == 0 && attribute.find(" msid:") != std::string::npos))
			media.removeAttribute(attribute);
	}
	if (streamIds.empty()) {
		if (trackId)
			media.addAttribute("msid:- " + *trackId);
		return;
	}
	for (const auto &streamId : streamIds) {
		auto attribute = "msid:" + streamId;
		if (trackId)
			attribute += " " + *trackId;
		media.addAttribute(std::move(attribute));
	}
}

void AddSupportedRtpHeaderExtensions(rtc::Description::Media &media) {
	media.addExtMap(rtc::Description::Media::ExtMap(MID_HEADER_EXTENSION_ID,
	                                                MID_HEADER_EXTENSION_URI));
}

struct RtpCodecDescription {
	int payloadType;
	std::string codec;
	int clockRate;
	std::optional<int> channels;
	std::optional<std::string> profile;
	std::vector<std::string> rtcpFeedback;
};

std::vector<RtpCodecDescription> ParseRtpCodecs(const Napi::Value &value) {
	if (!value.IsArray())
		throw std::invalid_argument("codecs must be an array");
	Napi::Array input = value.As<Napi::Array>();
	if (input.Length() == 0)
		throw std::invalid_argument("codecs must not be empty");

	std::vector<RtpCodecDescription> codecs;
	std::set<int> payloadTypes;
	codecs.reserve(input.Length());
	for (uint32_t i = 0; i < input.Length(); ++i) {
		if (!input.Get(i).IsObject())
			throw std::invalid_argument("codec entries must be objects");
		auto entry = input.Get(i).As<Napi::Object>();
		int payloadType = entry.Get("payloadType").ToNumber().Int32Value();
		std::string codec = entry.Get("codec").ToString().Utf8Value();
		int clockRate = entry.Get("clockRate").ToNumber().Int32Value();
		if (payloadType < 0 || payloadType > 127)
			throw std::invalid_argument("codec payloadType must be between 0 and 127");
		if (!payloadTypes.insert(payloadType).second)
			throw std::invalid_argument("codec payloadTypes must be unique");
		if (codec.empty() || std::any_of(codec.begin(), codec.end(), [](unsigned char c) {
			    return !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			             (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.');
		    }))
			throw std::invalid_argument("codec must be a non-empty SDP token");
		if (clockRate <= 0)
			throw std::invalid_argument("codec clockRate must be positive");

		std::optional<int> channels;
		if (entry.Has("channels") && !entry.Get("channels").IsNull() &&
		    !entry.Get("channels").IsUndefined()) {
			channels = entry.Get("channels").ToNumber().Int32Value();
			if (*channels <= 0 || *channels > 65535)
				throw std::invalid_argument("codec channels must be between 1 and 65535");
		}
		std::optional<std::string> profile;
		if (entry.Has("profile") && !entry.Get("profile").IsNull() &&
		    !entry.Get("profile").IsUndefined()) {
			profile = entry.Get("profile").ToString().Utf8Value();
			if (profile->empty() || profile->find_first_of("\r\n") != std::string::npos)
				throw std::invalid_argument("codec profile must be non-empty and contain no lines");
		}
		std::vector<std::string> rtcpFeedback;
		if (entry.Has("rtcpFeedback") && !entry.Get("rtcpFeedback").IsNull() &&
		    !entry.Get("rtcpFeedback").IsUndefined()) {
			auto feedbackValue = entry.Get("rtcpFeedback");
			if (!feedbackValue.IsArray())
				throw std::invalid_argument("codec rtcpFeedback must be an array");
			auto feedback = feedbackValue.As<Napi::Array>();
			for (uint32_t feedbackIndex = 0; feedbackIndex < feedback.Length(); ++feedbackIndex) {
				if (!feedback.Get(feedbackIndex).IsString())
					throw std::invalid_argument("codec rtcpFeedback entries must be strings");
				auto item = feedback.Get(feedbackIndex).ToString().Utf8Value();
				if (item.empty() || item.find_first_of("\r\n") != std::string::npos)
					throw std::invalid_argument(
					    "codec rtcpFeedback entries must be non-empty and contain no lines");
				rtcpFeedback.push_back(std::move(item));
			}
		}
		codecs.push_back({payloadType, std::move(codec), clockRate, channels,
		                  std::move(profile), std::move(rtcpFeedback)});
	}
	return codecs;
}

void AddRtpCodec(rtc::Description::Media &media, const RtpCodecDescription &codec) {
	std::string description = std::to_string(codec.payloadType) + " " + codec.codec + "/" +
	                          std::to_string(codec.clockRate);
	if (codec.channels)
		description += "/" + std::to_string(*codec.channels);
	rtc::Description::Media::RtpMap map(description);
	if (codec.profile)
		map.addParameter(*codec.profile);
	for (const auto &feedback : codec.rtcpFeedback)
		map.addFeedback(feedback);
	media.addRtpMap(std::move(map));
}

void ReplaceRtpCodecs(rtc::Description::Media &media,
	                  const std::vector<RtpCodecDescription> &codecs) {
	for (int payloadType : media.payloadTypes())
		media.removeRtpMap(payloadType);
	for (const auto &codec : codecs)
		AddRtpCodec(media, codec);
}

rtc::Description::Media ParseMediaDescription(const Napi::Value &value) {
	if (!value.IsObject())
		throw std::invalid_argument("track options must be an object");
	Napi::Object options = value.As<Napi::Object>();
	std::string kind = options.Get("kind").ToString().Utf8Value();
	std::string mid = options.Get("mid").ToString().Utf8Value();
	std::string direction = options.Get("direction").ToString().Utf8Value();
	auto codecs = ParseRtpCodecs(options.Get("codecs"));
	std::optional<std::string> trackId;
	if (options.Has("trackId") && !options.Get("trackId").IsNull() &&
	    !options.Get("trackId").IsUndefined())
		trackId = options.Get("trackId").ToString().Utf8Value();
	std::optional<std::string> cname;
	if (options.Has("cname") && !options.Get("cname").IsNull() &&
	    !options.Get("cname").IsUndefined())
		cname = options.Get("cname").ToString().Utf8Value();
	auto streamIds = ParseStringArray(options.Get("streamIds"), "streamIds");

	if (mid.empty())
		throw std::invalid_argument("mid must not be empty");
	if (std::any_of(mid.begin(), mid.end(), [](unsigned char c) { return c <= 0x20 || c == 0x7f; }))
		throw std::invalid_argument("mid must be an SDP token without whitespace or controls");
	if (trackId && (trackId->empty() || trackId->find_first_of(" \t\r\n") != std::string::npos))
		throw std::invalid_argument("trackId must be a non-empty SDP token");
	if (cname && (cname->empty() || cname->find_first_of(" \t\r\n") != std::string::npos))
		throw std::invalid_argument("cname must be a non-empty SDP token");

	rtc::Description::Direction parsedDirection = ParseMediaDirection(direction);
	if (kind == "audio") {
		rtc::Description::Audio media(mid, parsedDirection);
		ReplaceRtpCodecs(media, codecs);
		AddSupportedRtpHeaderExtensions(media);
		if (options.Has("ssrc") && !options.Get("ssrc").IsNull() &&
		    !options.Get("ssrc").IsUndefined())
			media.addSSRC(options.Get("ssrc").ToNumber().Uint32Value(), cname.value_or(mid));
		SetMediaStreamIds(media, streamIds, trackId);
		return media;
	}
	if (kind == "video") {
		rtc::Description::Video media(mid, parsedDirection);
		ReplaceRtpCodecs(media, codecs);
		AddSupportedRtpHeaderExtensions(media);
		if (options.Has("ssrc") && !options.Get("ssrc").IsNull() &&
		    !options.Get("ssrc").IsUndefined())
			media.addSSRC(options.Get("ssrc").ToNumber().Uint32Value(), cname.value_or(mid));
		SetMediaStreamIds(media, streamIds, trackId);
		return media;
	}
	throw std::invalid_argument("kind must be audio or video");
}

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

struct AsyncPeerTeardown {
	std::thread thread;
	std::shared_ptr<std::atomic<bool>> completed;
};

std::mutex &PeerTeardownMutex() {
	static auto *mutex = new std::mutex();
	return *mutex;
}

std::vector<AsyncPeerTeardown> &PeerTeardowns() {
	static auto *teardowns = new std::vector<AsyncPeerTeardown>();
	return *teardowns;
}

void SchedulePeerTeardown(PeerTeardownWork work) {
	std::lock_guard<std::mutex> lock(PeerTeardownMutex());
	auto &teardowns = PeerTeardowns();
	for (auto it = teardowns.begin(); it != teardowns.end();) {
		if (!it->completed->load(std::memory_order_acquire)) {
			++it;
			continue;
		}
		if (it->thread.joinable())
			it->thread.join();
		it = teardowns.erase(it);
	}

	auto completed = std::make_shared<std::atomic<bool>>(false);
	std::thread thread([work = std::move(work), completed]() mutable {
		try {
			RunPeerTeardown(std::move(work));
		} catch (...) {
			// Native teardown is best-effort and must never terminate the Node process.
		}
		completed->store(true, std::memory_order_release);
	});
	teardowns.push_back({std::move(thread), std::move(completed)});
}

void JoinPeerTeardowns() {
	std::vector<AsyncPeerTeardown> teardowns;
	{
		std::lock_guard<std::mutex> lock(PeerTeardownMutex());
		teardowns.swap(PeerTeardowns());
	}
	for (auto &teardown : teardowns)
		if (teardown.thread.joinable())
			teardown.thread.join();
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
	std::string target;
	std::string type;
	uint32_t channelId = 0;
	uint32_t trackId = 0;
	std::shared_ptr<ChannelBinding> channel;
	std::shared_ptr<TrackBinding> track;
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
		const bool queuedDataMessage = event.target == "datachannel" && event.type == "message";
		if (event.target != "track" && !queuedDataMessage) {
			EmitDirect(std::move(event));
			return;
		}

		bool scheduleDispatch = false;
		std::lock_guard<std::mutex> lock(lifecycleMutex);
		if (!active) {
			return;
		}
		if (event.target == "track" && pendingEvents.size() >= MAX_PENDING_TRACK_PACKETS)
			return;

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
	    : tsfn(Napi::ThreadSafeFunction::New(env, callback, "webrtc-node events", 0, 1)) {
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
		if (env == nullptr)
			return;
		try {
			scoped->Drain(env, callback);
		} catch (...) {
			// Exceptions cannot cross a thread-safe-function callback boundary.
		}
	}

	static void DispatchDirect(Napi::Env env, Napi::Function callback, NativeEvent *event) {
		std::unique_ptr<NativeEvent> scoped(event);
		if (env == nullptr)
			return;
		try {
			callback.Call({EventToObject(env, *scoped)});
		} catch (...) {
			// Environment teardown may invalidate JavaScript delivery mid-callback.
		}
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
	Napi::ThreadSafeFunction tsfn;
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
	      tsfn(Napi::ThreadSafeFunction::New(env, callback, "webrtc-node ICE UDP mux", 0, 1)) {
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
	Napi::ThreadSafeFunction tsfn;
	std::unique_ptr<rtc::IceUdpMuxListener> iceUdpMuxListener;
};

std::mutex &IceUdpMuxRegistryMutex() {
	static std::mutex mutex;
	return mutex;
}

std::vector<std::weak_ptr<IceUdpMuxBinding>> &IceUdpMuxRegistry() {
	static std::vector<std::weak_ptr<IceUdpMuxBinding>> registry;
	return registry;
}

void RegisterIceUdpMuxBinding(const std::shared_ptr<IceUdpMuxBinding> &binding) {
	std::lock_guard<std::mutex> lock(IceUdpMuxRegistryMutex());
	auto &registry = IceUdpMuxRegistry();
	registry.erase(std::remove_if(registry.begin(), registry.end(),
	                              [](const auto &entry) { return entry.expired(); }),
	               registry.end());
	registry.push_back(binding);
}

std::optional<uint16_t> ActiveIceUdpMuxPort() {
	std::lock_guard<std::mutex> lock(IceUdpMuxRegistryMutex());
	auto &registry = IceUdpMuxRegistry();
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

void CloseAllIceUdpMuxBindings() {
	std::vector<std::shared_ptr<IceUdpMuxBinding>> bindings;
	{
		std::lock_guard<std::mutex> lock(IceUdpMuxRegistryMutex());
		for (auto &entry : IceUdpMuxRegistry()) {
			if (auto binding = entry.lock())
				bindings.push_back(std::move(binding));
		}
		IceUdpMuxRegistry().clear();
	}
	for (auto &binding : bindings)
		binding->Close();
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
			RegisterIceUdpMuxBinding(binding_);
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
	                                              ChannelOptions options,
	                                              ClosedCallback closedCallback) {
		auto binding = std::shared_ptr<ChannelBinding>(new ChannelBinding(
		    std::move(dataChannel), std::move(dispatcher), std::move(options),
		    std::move(closedCallback)));
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

	void Close() {
		auto dc = dataChannel;
		if (!dc)
			return;
		std::thread([dc = std::move(dc)]() {
			try {
				dc->close();
			} catch (...) {
			}
		}).detach();
	}

	void Destroy() {
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
	ChannelBinding(std::shared_ptr<rtc::DataChannel> dataChannel_,
	               std::shared_ptr<EventDispatcher> dispatcher_, ChannelOptions options_,
	               ClosedCallback closedCallback_)
	    : id(AllocateChannelId()), dataChannel(std::move(dataChannel_)),
	      dispatcher(std::move(dispatcher_)), options(std::move(options_)),
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
	std::mutex callbacksMutex;
	ClosedCallback closedCallback;
};

class NativeDataChannel : public Napi::ObjectWrap<NativeDataChannel> {
public:
	static Napi::FunctionReference constructor;

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
		constructor = Napi::Persistent(func);
		constructor.SuppressDestruct();
		exports.Set("NativeDataChannel", func);
	}

	static Napi::Object NewInstance(Napi::Env env, std::shared_ptr<ChannelBinding> binding) {
		auto *payload = new std::shared_ptr<ChannelBinding>(std::move(binding));
		auto external = Napi::External<std::shared_ptr<ChannelBinding>>::New(
		    env, payload, [](Napi::Env, std::shared_ptr<ChannelBinding> *data) { delete data; });
		return constructor.New({external});
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
			std::string value = info[0].ToString().Utf8Value();
			bool sent = binding_->dataChannel->send(value);
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
			bool sent = binding_->dataChannel->send(bytes, view.ByteLength());
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
		return Napi::Number::New(info.Env(), binding_->dataChannel->bufferedAmount());
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

Napi::FunctionReference NativeDataChannel::constructor;

struct TrackBinding : public std::enable_shared_from_this<TrackBinding> {
	static std::shared_ptr<TrackBinding> Create(std::shared_ptr<rtc::Track> track,
	                                           std::shared_ptr<EventDispatcher> dispatcher,
	                                           bool ownsDispatcher = true) {
		auto binding = std::shared_ptr<TrackBinding>(
		    new TrackBinding(std::move(track), std::move(dispatcher), ownsDispatcher));
		binding->AttachCallbacks();
		return binding;
	}

	~TrackBinding() { Destroy(); }

	void Destroy() {
		{
			std::lock_guard<std::mutex> lock(callbacksMutex);
			if (!callbacksActive)
				return;
			callbacksActive = false;
		}
		if (track)
			track->resetCallbacks();
		if (ownsDispatcher)
			dispatcher->Close();
	}

	void Close() {
		if (!track)
			return;
		try {
			track->close();
		} catch (...) {
		}
	}

	std::shared_ptr<rtc::Track> track;
	std::shared_ptr<EventDispatcher> dispatcher;
	const uint32_t id;
	std::atomic<uint64_t> packetsSent{0};
	std::atomic<uint64_t> bytesSent{0};
	std::atomic<uint64_t> packetsReceived{0};
	std::atomic<uint64_t> bytesReceived{0};
	std::atomic<bool> active{true};

private:
	TrackBinding(std::shared_ptr<rtc::Track> track_,
	             std::shared_ptr<EventDispatcher> dispatcher_, bool ownsDispatcher_)
	    : track(std::move(track_)), dispatcher(std::move(dispatcher_)), id(AllocateTrackId()),
	      ownsDispatcher(ownsDispatcher_) {}

	void Emit(NativeEvent event) {
		std::lock_guard<std::mutex> lock(callbacksMutex);
		if (callbacksActive) {
			event.trackId = id;
			dispatcher->Emit(std::move(event));
		}
	}

	void AttachCallbacks() {
		std::weak_ptr<TrackBinding> weak = shared_from_this();
		track->onOpen([weak]() {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "track";
				event.type = "open";
				self->Emit(std::move(event));
			}
		});
		track->onClosed([weak]() {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "track";
				event.type = "close";
				self->Emit(std::move(event));
			}
		});
		track->onError([weak](std::string error) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "track";
				event.type = "error";
				event.error = std::move(error);
				self->Emit(std::move(event));
			}
		});
		track->onMessage([weak](rtc::message_variant data) {
			if (auto self = weak.lock()) {
				NativeEvent event;
				event.target = "track";
				event.type = "message";
				event.binary = true;
				if (std::holds_alternative<rtc::binary>(data))
					event.bytes = std::move(std::get<rtc::binary>(data));
				else {
					const auto &text = std::get<std::string>(data);
					event.bytes.assign(reinterpret_cast<const rtc::byte *>(text.data()),
					                   reinterpret_cast<const rtc::byte *>(text.data() + text.size()));
				}
				if (IsRtpPacket(event.bytes.data(), event.bytes.size())) {
					self->packetsReceived.fetch_add(1, std::memory_order_relaxed);
					self->bytesReceived.fetch_add(event.bytes.size(), std::memory_order_relaxed);
				}
				self->Emit(std::move(event));
			}
		});
	}

	bool callbacksActive = true;
	bool ownsDispatcher = true;
	std::mutex callbacksMutex;
};

class NativeTrack : public Napi::ObjectWrap<NativeTrack> {
public:
	static Napi::FunctionReference constructor;

	static void Init(Napi::Env env, Napi::Object exports) {
		Napi::Function func = DefineClass(
		    env, "NativeTrack",
		    {
		        InstanceMethod("send", &NativeTrack::Send),
		        InstanceMethod("setActive", &NativeTrack::SetActive),
		        InstanceMethod("close", &NativeTrack::Close),
		        InstanceMethod("stats", &NativeTrack::Stats),
		        InstanceMethod("updateDescription", &NativeTrack::UpdateDescription),
		        InstanceAccessor("bindingId", &NativeTrack::GetBindingId, nullptr),
		        InstanceAccessor("mid", &NativeTrack::GetMid, nullptr),
		        InstanceAccessor("kind", &NativeTrack::GetKind, nullptr),
		        InstanceAccessor("direction", &NativeTrack::GetDirection, nullptr),
		        InstanceAccessor("ssrc", &NativeTrack::GetSsrc, nullptr),
		        InstanceAccessor("isOpen", &NativeTrack::GetIsOpen, nullptr),
		        InstanceAccessor("isClosed", &NativeTrack::GetIsClosed, nullptr),
		        InstanceAccessor("maxMessageSize", &NativeTrack::GetMaxMessageSize, nullptr),
		    });
		constructor = Napi::Persistent(func);
		constructor.SuppressDestruct();
		exports.Set("NativeTrack", func);
	}

	static Napi::Object NewInstance(Napi::Env env, std::shared_ptr<TrackBinding> binding) {
		auto *payload = new std::shared_ptr<TrackBinding>(std::move(binding));
		auto external = Napi::External<std::shared_ptr<TrackBinding>>::New(
		    env, payload, [](Napi::Env, std::shared_ptr<TrackBinding> *data) { delete data; });
		return constructor.New({external});
	}

	NativeTrack(const Napi::CallbackInfo &info) : Napi::ObjectWrap<NativeTrack>(info) {
		if (!info[0].IsExternal())
			throw Napi::TypeError::New(info.Env(), "NativeTrack requires a native binding");
		binding_ = *info[0].As<Napi::External<std::shared_ptr<TrackBinding>>>().Data();
	}

	~NativeTrack() override {
		if (binding_)
			binding_->Destroy();
	}

private:
	std::shared_ptr<TrackBinding> binding_;

	Napi::Value GetBindingId(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), binding_->id);
	}

	Napi::Value Send(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			if (!info[0].IsTypedArray())
				throw std::invalid_argument("send expects a Uint8Array containing RTP or RTCP");
			auto view = info[0].As<Napi::Uint8Array>();
			const auto *bytes = reinterpret_cast<const rtc::byte *>(view.Data());
			const bool isRtp = IsRtpPacket(bytes, view.ByteLength());
			if (isRtp && !binding_->active.load(std::memory_order_acquire))
				return Napi::Boolean::New(env, false);
			const bool sent = binding_->track->send(bytes, view.ByteLength());
			if (sent && isRtp) {
				binding_->packetsSent.fetch_add(1, std::memory_order_relaxed);
				binding_->bytesSent.fetch_add(view.ByteLength(), std::memory_order_relaxed);
			}
			return Napi::Boolean::New(env, sent);
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value SetActive(const Napi::CallbackInfo &info) {
		binding_->active.store(info[0].ToBoolean().Value(), std::memory_order_release);
		return info.Env().Undefined();
	}

	Napi::Value Close(const Napi::CallbackInfo &info) {
		binding_->Close();
		return info.Env().Undefined();
	}

	Napi::Value Stats(const Napi::CallbackInfo &info) {
		Napi::Object result = Napi::Object::New(info.Env());
		result.Set("packetsSent", Napi::Number::New(info.Env(), binding_->packetsSent.load()));
		result.Set("bytesSent", Napi::Number::New(info.Env(), binding_->bytesSent.load()));
		result.Set("packetsReceived", Napi::Number::New(info.Env(), binding_->packetsReceived.load()));
		result.Set("bytesReceived", Napi::Number::New(info.Env(), binding_->bytesReceived.load()));
		return result;
	}

	Napi::Value UpdateDescription(const Napi::CallbackInfo &info) {
		try {
			if (info.Length() < 7)
				throw std::invalid_argument("updateDescription requires complete media state");
			auto streamIds = ParseStringArray(info[3], "streamIds");
			auto codecs = ParseRtpCodecs(info[6]);
			std::optional<std::string> trackId;
			if (!info[4].IsNull() && !info[4].IsUndefined())
				trackId = info[4].ToString().Utf8Value();
			if (trackId &&
			    (trackId->empty() || trackId->find_first_of(" \t\r\n") != std::string::npos))
				throw std::invalid_argument("trackId must be a non-empty SDP token");
			std::optional<std::string> cname;
			if (info.Length() > 5 && !info[5].IsNull() && !info[5].IsUndefined())
				cname = info[5].ToString().Utf8Value();
			if (cname &&
			    (cname->empty() || cname->find_first_of(" \t\r\n") != std::string::npos))
				throw std::invalid_argument("cname must be a non-empty SDP token");

			auto description = binding_->track->description();
			if (info.Length() > 1 && info[1].ToBoolean().Value()) {
				description.setDirection(rtc::Description::Direction::Inactive);
				description.markRemoved();
			} else
				description.setDirection(ParseMediaDirection(info[0].ToString().Utf8Value()));
			description.clearSSRCs();
			if (!info[2].IsNull() && !info[2].IsUndefined()) {
				auto ssrc = info[2].ToNumber().Uint32Value();
				if (ssrc == 0)
					throw std::invalid_argument("ssrc must be between 1 and 4294967295");
				description.addSSRC(ssrc, cname.value_or(description.mid()));
			}
			SetMediaStreamIds(description, streamIds, trackId);
			ReplaceRtpCodecs(description, codecs);
			binding_->track->setDescription(std::move(description));
		} catch (const std::exception &e) {
			Napi::Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
		}
		return info.Env().Undefined();
	}

	Napi::Value GetMid(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), binding_->track->mid());
	}
	Napi::Value GetKind(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), binding_->track->description().type());
	}
	Napi::Value GetDirection(const Napi::CallbackInfo &info) {
		std::ostringstream output;
		output << binding_->track->direction();
		return Napi::String::New(info.Env(), output.str());
	}
	Napi::Value GetSsrc(const Napi::CallbackInfo &info) {
		const auto values = binding_->track->description().getSSRCs();
		if (values.empty())
			return info.Env().Null();
		return Napi::Number::New(info.Env(), values.front());
	}
	Napi::Value GetIsOpen(const Napi::CallbackInfo &info) {
		return Napi::Boolean::New(info.Env(), binding_->track->isOpen());
	}
	Napi::Value GetIsClosed(const Napi::CallbackInfo &info) {
		return Napi::Boolean::New(info.Env(), binding_->track->isClosed());
	}
	Napi::Value GetMaxMessageSize(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), binding_->track->maxMessageSize());
	}
};

Napi::FunctionReference NativeTrack::constructor;

Napi::Object EventDispatcher::EventToObject(Napi::Env env, NativeEvent &event) {
	Napi::Object object = Napi::Object::New(env);
	object.Set("target", event.target);
	object.Set("type", event.type);
	if (event.channelId)
		object.Set("channelId", event.channelId);
	if (event.trackId)
		object.Set("trackId", event.trackId);
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
	if (event.track)
		object.Set("track", NativeTrack::NewInstance(env, event.track));

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
	config.forceMediaTransport = true;

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
		if (auto port = ActiveIceUdpMuxPort()) {
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
	                                           std::shared_ptr<EventDispatcher> dispatcher) {
		auto binding =
		    std::shared_ptr<PeerBinding>(new PeerBinding(std::move(config), std::move(dispatcher)));
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
		    std::move(dataChannel), dispatcher, std::move(options),
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
			channel->Destroy();
			CloseDataChannelForTeardown(channel->dataChannel);
			return nullptr;
		}
		if (channel->dataChannel->isClosed())
			RemoveChannel(channel->id, channel.get());
		return channel;
	}

	bool AddTrackBinding(const std::shared_ptr<TrackBinding> &track) {
		std::lock_guard<std::mutex> lock(tracksMutex);
		if (shutdown.load())
			return false;
		trackBindings.erase(
		    std::remove_if(trackBindings.begin(), trackBindings.end(),
		                   [](const auto &entry) { return entry.expired(); }),
		    trackBindings.end());
		trackBindings.push_back(track);
		return true;
	}

	void ClosePeer() { ScheduleShutdown(); }

	void Destroy() { ScheduleShutdown(); }

	void DestroySync() {
		auto work = PrepareShutdown();
		if (work)
			RunPeerTeardown(std::move(*work));
	}

	std::shared_ptr<rtc::PeerConnection> AcquirePeerConnection() const {
		std::lock_guard<std::mutex> lock(peerConnectionMutex);
		return peerConnection;
	}

	std::shared_ptr<rtc::PeerConnection> peerConnection;
	std::shared_ptr<EventDispatcher> dispatcher;

private:
	PeerBinding(rtc::Configuration config, std::shared_ptr<EventDispatcher> dispatcher_)
	    : peerConnection(std::make_shared<rtc::PeerConnection>(std::move(config))),
	      dispatcher(std::move(dispatcher_)) {}

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
		if (auto peer = AcquirePeerConnection())
			peer->resetCallbacks();
	}

	void RemoveChannel(uint32_t id, const ChannelBinding *expected) {
		std::lock_guard<std::mutex> lock(channelsMutex);
		auto found = channels.find(id);
		if (found != channels.end() && found->second.get() == expected)
			channels.erase(found);
	}

	std::optional<PeerTeardownWork> PrepareShutdown() {
		if (shutdown.exchange(true))
			return std::nullopt;

		std::vector<std::shared_ptr<ChannelBinding>> channelSnapshot;
		{
			std::lock_guard<std::mutex> lock(channelsMutex);
			channelSnapshot.reserve(channels.size());
			for (auto &[_, channel] : channels)
				channelSnapshot.push_back(channel);
			channels.clear();
		}
		std::vector<std::shared_ptr<TrackBinding>> trackSnapshot;
		{
			std::lock_guard<std::mutex> lock(tracksMutex);
			for (auto &entry : trackBindings)
				if (auto track = entry.lock())
					trackSnapshot.push_back(std::move(track));
			trackBindings.clear();
		}

		PeerTeardownWork work;
		work.dataChannels.reserve(channelSnapshot.size());
		for (auto &channel : channelSnapshot) {
			channel->Destroy();
			if (channel->dataChannel)
				work.dataChannels.push_back(channel->dataChannel);
		}
		for (auto &track : trackSnapshot) {
			track->Destroy();
		}
		DeactivateCallbacks();
		dispatcher->Close();
		{
			std::lock_guard<std::mutex> lock(peerConnectionMutex);
			work.peerConnection = std::move(peerConnection);
		}
		return work;
	}

	void ScheduleShutdown() {
		auto work = PrepareShutdown();
		if (!work)
			return;

		SchedulePeerTeardown(std::move(*work));
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

		peerConnection->onTrack([weak](std::shared_ptr<rtc::Track> nativeTrack) {
			if (auto self = weak.lock()) {
			auto track = TrackBinding::Create(nativeTrack, self->dispatcher, false);
				if (!self->AddTrackBinding(track)) {
					track->Destroy();
					track->Close();
					return;
				}
				NativeEvent event;
				event.target = "peerconnection";
				event.type = "track";
				event.track = std::move(track);
				self->Emit(std::move(event));
			}
		});
	}

	std::atomic<bool> shutdown{false};
	mutable std::mutex peerConnectionMutex;
	bool callbacksActive = true;
	std::mutex callbacksMutex;
	std::mutex channelsMutex;
	std::unordered_map<uint32_t, std::shared_ptr<ChannelBinding>> channels;
	std::mutex tracksMutex;
	std::vector<std::weak_ptr<TrackBinding>> trackBindings;
};

std::mutex &PeerRegistryMutex() {
	static std::mutex mutex;
	return mutex;
}

std::vector<std::weak_ptr<PeerBinding>> &PeerRegistry() {
	static std::vector<std::weak_ptr<PeerBinding>> registry;
	return registry;
}

void RegisterPeerBinding(const std::shared_ptr<PeerBinding> &binding) {
	std::lock_guard<std::mutex> lock(PeerRegistryMutex());
	auto &registry = PeerRegistry();
	registry.erase(std::remove_if(registry.begin(), registry.end(),
	                              [](const auto &entry) { return entry.expired(); }),
	               registry.end());
	registry.push_back(binding);
}

void CloseAllPeerBindings() {
	std::vector<std::shared_ptr<PeerBinding>> bindings;
	{
		std::lock_guard<std::mutex> lock(PeerRegistryMutex());
		for (auto &entry : PeerRegistry()) {
			if (auto binding = entry.lock())
				bindings.push_back(std::move(binding));
		}
		PeerRegistry().clear();
	}
	for (auto &binding : bindings)
		binding->DestroySync();
}

class NativePeerConnection : public Napi::ObjectWrap<NativePeerConnection> {
public:
	static Napi::FunctionReference constructor;

	static void Init(Napi::Env env, Napi::Object exports) {
		Napi::Function func = DefineClass(
		    env, "NativePeerConnection",
		    {
		        InstanceMethod("createDataChannel", &NativePeerConnection::CreateDataChannel),
		        InstanceMethod("createTrack", &NativePeerConnection::CreateTrack),
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
		        InstanceMethod("transportStats", &NativePeerConnection::TransportStats),
		        InstanceMethod("clearTransportStats", &NativePeerConnection::ClearTransportStats),
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
		constructor = Napi::Persistent(func);
		constructor.SuppressDestruct();
		exports.Set("NativePeerConnection", func);
	}

	NativePeerConnection(const Napi::CallbackInfo &info)
	    : Napi::ObjectWrap<NativePeerConnection>(info) {
		Napi::Env env = info.Env();
		if (info.Length() < 2 || !info[1].IsFunction())
			throw Napi::TypeError::New(env, "NativePeerConnection requires an event callback");
		auto dispatcher = EventDispatcher::Create(env, info[1].As<Napi::Function>());
		binding_ = PeerBinding::Create(ParseConfiguration(info), dispatcher);
		RegisterPeerBinding(binding_);
	}

	~NativePeerConnection() override {
		if (binding_)
			binding_->Destroy();
	}

private:
	std::shared_ptr<PeerBinding> binding_;

	std::shared_ptr<rtc::PeerConnection> Peer() const {
		auto peer = binding_ ? binding_->AcquirePeerConnection() : nullptr;
		if (!peer)
			throw std::runtime_error("Peer connection is closed");
		return peer;
	}

	Napi::Value CreateDataChannel(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			std::string label = info[0].ToString().Utf8Value();
			ChannelOptions options =
			    ParseChannelOptions(info.Length() > 1 ? info[1] : env.Undefined());
			auto dataChannel = Peer()->createDataChannel(label, ToRtcInit(options));
			auto channel = binding_->AddChannel(std::move(dataChannel), std::move(options));
			return NativeDataChannel::NewInstance(env, std::move(channel));
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value CreateTrack(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			if (info.Length() < 2 || !info[1].IsFunction())
				throw std::invalid_argument("createTrack requires options and an event callback");
			auto description = ParseMediaDescription(info[0]);
			auto track = Peer()->addTrack(std::move(description));
			auto dispatcher = EventDispatcher::Create(env, info[1].As<Napi::Function>());
			auto trackBinding = TrackBinding::Create(std::move(track), std::move(dispatcher));
			if (!binding_->AddTrackBinding(trackBinding)) {
				trackBinding->Destroy();
				trackBinding->Close();
				throw std::runtime_error("Peer connection is closed");
			}
			return NativeTrack::NewInstance(env, std::move(trackBinding));
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value CreateOffer(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			return DescriptionToObject(env, Peer()->createOffer());
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value CreateAnswer(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			return DescriptionToObject(env, Peer()->createAnswer());
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
			Peer()->setLocalDescription(ParseDescriptionType(type), init);
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
			Peer()->setRemoteDescription(rtc::Description(sdp, type));
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
			Peer()->addRemoteCandidate(rtc::Candidate(candidate, mid));
			return env.Undefined();
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value GatherLocalCandidates(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			Peer()->gatherLocalCandidates();
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
		}
		return env.Undefined();
	}

	Napi::Value LocalDescription(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			auto description = Peer()->localDescription();
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
			auto description = Peer()->remoteDescription();
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
			auto fingerprint = Peer()->remoteFingerprint();
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
			if (!Peer()->getSelectedCandidatePair(&local, &remote))
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

	Napi::Value TransportStats(const Napi::CallbackInfo &info) {
		Napi::Env env = info.Env();
		try {
			Napi::Object result = Napi::Object::New(env);
			auto peer = Peer();
			result.Set("bytesSent", Napi::Number::New(env, peer->bytesSent()));
			result.Set("bytesReceived",
			           Napi::Number::New(env, peer->bytesReceived()));
			auto rtt = peer->rtt();
			result.Set("roundTripTime",
			           rtt ? Napi::Number::New(env, rtt->count() / 1000.0) : env.Null());
			auto localAddress = peer->localAddress();
			result.Set("localAddress", localAddress ? Napi::String::New(env, *localAddress)
			                                        : env.Null());
			auto remoteAddress = peer->remoteAddress();
			result.Set("remoteAddress", remoteAddress ? Napi::String::New(env, *remoteAddress)
			                                          : env.Null());
			return result;
		} catch (const std::exception &e) {
			Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
			return env.Undefined();
		}
	}

	Napi::Value ClearTransportStats(const Napi::CallbackInfo &info) {
		try {
			Peer()->clearStats();
		} catch (const std::exception &e) {
			Napi::Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
		}
		return info.Env().Undefined();
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
		return Napi::String::New(info.Env(), ToString(Peer()->state()));
	}

	Napi::Value GetIceConnectionState(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), ToString(Peer()->iceState()));
	}

	Napi::Value GetIceGatheringState(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), ToString(Peer()->gatheringState()));
	}

	Napi::Value GetSignalingState(const Napi::CallbackInfo &info) {
		return Napi::String::New(info.Env(), ToString(Peer()->signalingState()));
	}

	Napi::Value GetRemoteMaxMessageSize(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), Peer()->remoteMaxMessageSize());
	}

	Napi::Value GetMaxDataChannelId(const Napi::CallbackInfo &info) {
		return Napi::Number::New(info.Env(), Peer()->maxDataChannelId());
	}
};

Napi::FunctionReference NativePeerConnection::constructor;

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

void CleanupNative() {
	CloseAllPeerBindings();
	CloseAllIceUdpMuxBindings();
	JoinPeerTeardowns();
	rtc::Cleanup().wait();
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
	ConfigureLibDataChannelLogging();
	NativeDataChannel::Init(env, exports);
	NativeTrack::Init(env, exports);
	NativeIceUdpMuxListener::Init(env, exports);
	NativePeerConnection::Init(env, exports);
	exports.Set("generateCertificate", Napi::Function::New(env, GenerateCertificate));
	exports.Set("importCertificate", Napi::Function::New(env, ImportCertificate));
	env.AddCleanupHook([]() { CleanupNative(); });
	exports.Set("cleanup", Napi::Function::New(env, [](const Napi::CallbackInfo &info) {
		            CleanupNative();
		            return info.Env().Undefined();
	            }));
	return exports;
}

} // namespace

NODE_API_MODULE(webrtc_node, InitAll)
