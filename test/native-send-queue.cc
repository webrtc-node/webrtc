#include "send_queue.hpp"
#include "teardown_tasks.hpp"

#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using webrtc_node::SendQueue;
using webrtc_node::TeardownTasks;
using namespace std::chrono_literals;

namespace {

void Require(bool condition, const char *message) {
	if (!condition)
		throw std::runtime_error(message);
}

template <typename Run> void Rejects(Run run, const char *message) {
	try {
		run();
	} catch (const std::runtime_error &error) {
		Require(std::string(error.what()) == message, "Unexpected queue rejection");
		return;
	}
	throw std::runtime_error("Expected queue rejection");
}

struct Gate {
	std::mutex mutex;
	std::condition_variable condition;
	bool started = false;
	bool open = false;

	void Block() {
		std::unique_lock lock(mutex);
		started = true;
		condition.notify_all();
		condition.wait(lock, [&]() { return open; });
	}
	void WaitUntilStarted() {
		std::unique_lock lock(mutex);
		Require(condition.wait_for(lock, 5s, [&]() { return started; }), "Send worker did not start");
	}
	void Open() {
		std::lock_guard lock(mutex);
		open = true;
		condition.notify_all();
	}
};

struct BlockedQueue {
	Gate gate;
	SendQueue queue;
	~BlockedQueue() {
		gate.Open();
		queue.Stop();
	}
	void Block(size_t bytes) {
		queue.Enqueue([this]() { gate.Block(); }, bytes);
		gate.WaitUntilStarted();
	}
};

void ByteLimitAndPayloadAdmission() {
	std::vector<int> order;
	BlockedQueue fixture;
	fixture.Block(64 * 1024 * 1024 - 1);
	const auto caller = std::this_thread::get_id();
	int produced = 0;
	auto factory = [&]() {
		Require(std::this_thread::get_id() == caller, "Payload factory left the submitting thread");
		++produced;
		return [&]() { order.push_back(1); };
	};
	fixture.queue.EnqueueProduced(1, factory);
	Rejects([&]() { fixture.queue.EnqueueProduced(1, factory); }, "Native send queue is full");
	Rejects([&]() { fixture.queue.EnqueueProduced(64 * 1024 * 1024 + 1, factory); },
	        "Native send queue is full");
	Require(produced == 1, "Rejected sends produced a payload");
	std::promise<void> closed;
	auto done = closed.get_future();
	fixture.queue.Enqueue([&]() { order.push_back(2); closed.set_value(); }, 0, true);
	fixture.gate.Open();
	Require(done.wait_for(5s) == std::future_status::ready, "Full byte queue blocked close");
	Require(order == std::vector<int>({1, 2}), "Close overtook an accepted send");
	fixture.queue.Stop();
}

void EmptyMessagesRespectJobLimit() {
	BlockedQueue fixture;
	fixture.Block(0);
	for (size_t index = 1; index < 65536; ++index)
		fixture.queue.Enqueue([]() {}, 0);
	bool produced = false;
	Rejects([&]() {
		fixture.queue.EnqueueProduced(0, [&]() {
			produced = true;
			return []() {};
		});
	}, "Native send queue is full");
	Require(!produced, "A full zero-byte queue produced a payload");
	std::promise<void> closed;
	auto done = closed.get_future();
	fixture.queue.Enqueue([&]() { closed.set_value(); }, 0, true);
	fixture.gate.Open();
	Require(done.wait_for(5s) == std::future_status::ready, "Full job queue blocked close");
	fixture.queue.Stop();
}

struct StopThread {
	BlockedQueue &fixture;
	std::thread thread;
	StopThread(BlockedQueue &fixture_, std::atomic<bool> &stopped) : fixture(fixture_) {
		thread = std::thread([&fixture_, &stopped]() {
			fixture_.queue.Stop();
			stopped.store(true);
		});
	}
	~StopThread() {
		fixture.gate.Open();
		if (thread.joinable())
			thread.join();
	}
};

void ShutdownDiscardsAndJoins() {
	std::promise<void> released;
	auto dropped = released.get_future();
	std::atomic<bool> ran{false};
	std::atomic<bool> stopped{false};
	BlockedQueue fixture;
	fixture.Block(1);
	auto payload = std::shared_ptr<int>(new int(1), [&](int *data) {
		delete data;
		released.set_value();
	});
	fixture.queue.Enqueue([payload, &ran]() { ran.store(true); }, 1);
	payload.reset();
	StopThread stopper(fixture, stopped);
	Require(dropped.wait_for(5s) == std::future_status::ready, "Shutdown retained an unstarted payload");
	Require(!stopped.load(), "Shutdown returned before its active job finished");
	fixture.gate.Open();
	stopper.thread.join();
	Require(stopped.load() && !ran.load(), "Shutdown ran a discarded job");
	bool produced = false;
	Rejects([&]() {
		fixture.queue.EnqueueProduced(1, [&]() {
			produced = true;
			return []() {};
		});
	}, "Native send queue is stopped");
	Require(!produced, "A stopped queue produced a payload");
	fixture.queue.Stop();
}

void TeardownJoinsThroughThreadExit() {
	Gate exitGate;
	TeardownTasks tasks;
	struct OpenOnExit {
		Gate &gate;
		~OpenOnExit() { gate.Open(); }
	} openOnExit{exitGate};
	struct ThreadExit {
		Gate *gate;
		~ThreadExit() { gate->Block(); }
	};
	tasks.Start([&]() {
		thread_local ThreadExit cleanup{&exitGate};
	});
	exitGate.WaitUntilStarted();
	auto joined = std::async(std::launch::async, [&]() { tasks.Join(); });
	const bool waited = joined.wait_for(50ms) == std::future_status::timeout;
	exitGate.Open();
	joined.get();
	Require(waited, "Teardown returned while thread-local destructors were still running");
	std::atomic<bool> ran{false};
	tasks.Start([&]() { ran.store(true); });
	tasks.Join();
	Require(ran.load(), "Explicit cleanup prevented later teardown work");
}

} // namespace

int main() {
	try {
		ByteLimitAndPayloadAdmission();
		EmptyMessagesRespectJobLimit();
		ShutdownDiscardsAndJoins();
		TeardownJoinsThroughThreadExit();
		std::cout << "Native send queue and teardown: 4 cases passed\n";
		return 0;
	} catch (const std::exception &error) {
		std::cerr << error.what() << '\n';
		return 1;
	}
}
