#pragma once

#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace webrtc_node {

class SendQueue {
	struct Job {
		std::function<void()> run;
		size_t bytes;
	};
	static constexpr size_t MAX_BYTES = 64 * 1024 * 1024;
	static constexpr size_t MAX_JOBS = 65536;
	std::mutex mutex;
	std::condition_variable ready;
	std::deque<Job> jobs;
	std::thread worker;
	size_t bufferedBytes = 0;
	size_t bufferedJobs = 0;
	bool stopped = false;

	void CheckCapacityLocked(size_t bytes, bool control) const {
		if (stopped)
			throw std::runtime_error("Native send queue is stopped");
		if (!control && (bytes > MAX_BYTES - bufferedBytes || bufferedJobs >= MAX_JOBS))
			throw std::runtime_error("Native send queue is full");
	}

	void Run() {
		for (;;) {
			Job job;
			{
				std::unique_lock lock(mutex);
				ready.wait(lock, [&]() { return stopped || !jobs.empty(); });
				if (stopped)
					return;
				job = std::move(jobs.front());
				jobs.pop_front();
			}
			job.run();
			job.run = {};
			{
				std::lock_guard lock(mutex);
				bufferedBytes -= job.bytes;
				--bufferedJobs;
			}
		}
	}

public:
	~SendQueue() { Stop(); }

	void Enqueue(std::function<void()> run, size_t bytes, bool control = false) {
		{
			std::lock_guard lock(mutex);
			CheckCapacityLocked(bytes, control);
			if (!worker.joinable())
				worker = std::thread([this]() { Run(); });
			jobs.push_back({std::move(run), bytes});
			bufferedBytes += bytes;
			++bufferedJobs;
		}
		ready.notify_one();
	}

	// The factory runs on the submitting thread after checking capacity.
	template <typename Factory> void EnqueueProduced(size_t bytes, Factory factory) {
		{
			std::lock_guard lock(mutex);
			CheckCapacityLocked(bytes, false);
		}
		Enqueue(factory(), bytes);
	}

	void Stop() {
		std::deque<Job> discarded;
		{
			std::lock_guard lock(mutex);
			stopped = true;
			discarded.swap(jobs);
		}
		ready.notify_one();
		discarded.clear();
		if (worker.joinable())
			worker.join();
	}
};

} // namespace webrtc_node
