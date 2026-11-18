#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <thread>
#include <utility>
#include <vector>

namespace webrtc_node {

// Scheduling and joining belong to the owning Node environment thread.
class TeardownTasks {
	struct Task {
		std::shared_ptr<std::atomic<bool>> finished;
		std::thread thread;
	};
	std::vector<Task> tasks;

	static void Execute(std::function<void()> &run) noexcept {
		try {
			run();
		} catch (...) {
			// Native handle destruction remains best-effort during shutdown.
		}
	}

public:
	~TeardownTasks() { Join(); }

	void Start(std::function<void()> run) {
		for (auto task = tasks.begin(); task != tasks.end();) {
			if (!task->finished->load()) {
				++task;
				continue;
			}
			task->thread.join();
			task = tasks.erase(task);
		}
		auto finished = std::make_shared<std::atomic<bool>>(false);
		tasks.push_back({finished, {}});
		try {
			tasks.back().thread = std::thread([run, finished]() mutable {
				Execute(run);
				finished->store(true);
			});
		} catch (...) {
			tasks.pop_back();
			Execute(run);
		}
	}

	void Join() {
		for (auto &task : tasks)
			task.thread.join();
		tasks.clear();
	}
};

} // namespace webrtc_node
