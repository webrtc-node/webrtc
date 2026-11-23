#pragma once

#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace webrtc_node {

// Runs blocking peer teardowns off the JavaScript thread. A task goes to an
// idle worker when one is waiting and otherwise starts a new thread, so a slow
// teardown never delays another one. Workers wait briefly for more work before
// exiting, which lets bursts of closes reuse a few threads instead of creating
// one per peer. Scheduling and joining belong to the owning Node environment
// thread.
class TeardownTasks {
	static constexpr auto IDLE_TIMEOUT = std::chrono::seconds(2);

	std::mutex mutex;
	std::condition_variable wake;
	std::deque<std::function<void()>> queue; // guarded by mutex
	std::vector<std::thread> threads;        // owned by the environment thread
	std::vector<std::thread::id> exited;     // guarded by mutex
	size_t idle = 0;                         // guarded by mutex; workers waiting
	size_t claimed = 0;                      // guarded by mutex; idle workers assigned a task
	bool stopping = false;                   // guarded by mutex

	static void Execute(std::function<void()> &run) noexcept {
		try {
			run();
		} catch (...) {
			// Native handle destruction remains best-effort during shutdown.
		}
	}

	void Work() {
		std::unique_lock lock(mutex);
		for (;;) {
			if (queue.empty()) {
				if (stopping)
					break;
				++idle;
				const bool woken =
				    wake.wait_for(lock, IDLE_TIMEOUT, [&]() { return stopping || !queue.empty(); });
				--idle;
				if (claimed > 0 && !queue.empty())
					--claimed;
				if (queue.empty()) {
					if (stopping || !woken)
						break;
					continue;
				}
			}
			auto run = std::move(queue.front());
			queue.pop_front();
			lock.unlock();
			Execute(run);
			run = {};
			lock.lock();
		}
		exited.push_back(std::this_thread::get_id());
	}

	// Joins workers that have already left their loop.
	void ReapExited() {
		std::vector<std::thread::id> done;
		{
			std::lock_guard lock(mutex);
			done.swap(exited);
		}
		for (const auto &id : done) {
			for (auto thread = threads.begin(); thread != threads.end(); ++thread) {
				if (thread->get_id() == id) {
					thread->join();
					threads.erase(thread);
					break;
				}
			}
		}
	}

public:
	~TeardownTasks() { Join(); }

	void Start(std::function<void()> run) {
		ReapExited();
		std::unique_lock lock(mutex);
		if (idle > claimed) {
			// A stale claim only makes a later task start a thread; none is stranded.
			++claimed;
			queue.push_back(std::move(run));
			wake.notify_one();
			return;
		}
		try {
			threads.emplace_back([this]() { Work(); });
		} catch (...) {
			// Without a new thread, run the task here as the last resort.
			lock.unlock();
			Execute(run);
			return;
		}
		queue.push_back(std::move(run));
	}

	// Waits for every scheduled teardown, then leaves the pool ready for reuse.
	void Join() {
		{
			std::lock_guard lock(mutex);
			stopping = true;
		}
		wake.notify_all();
		for (auto &thread : threads)
			thread.join();
		threads.clear();
		std::lock_guard lock(mutex);
		exited.clear();
		idle = 0;
		claimed = 0;
		stopping = false;
	}
};

} // namespace webrtc_node
