#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace webrtc_node {

// Tracks a single peer's admitted sends, including empty and in-flight messages.
class PeerSendHandoff {
	using Clock = std::chrono::steady_clock;
	using Tick = Clock::duration::rep;
	static constexpr Tick OPEN = Clock::duration::max().count();
	std::atomic<Tick> deadline{OPEN};
	std::atomic<size_t> pending{0};
	std::mutex completionMutex;
	std::condition_variable completed;

	void Complete() {
		if (pending.fetch_sub(1) == 1 && !Accepting()) {
			// Coordinate the last completion with the teardown wait. If this
			// happened before Close(), the waiter will already see zero.
			std::lock_guard lock(completionMutex);
			completed.notify_one();
		}
	}

public:
	class Pending {
		PeerSendHandoff &peer;

	public:
		explicit Pending(PeerSendHandoff &peer_) : peer(peer_) { ++peer.pending; }
		Pending(const Pending &) = delete;
		Pending &operator=(const Pending &) = delete;
		~Pending() { peer.Complete(); }
	};

	bool Accepting() const { return deadline.load() == OPEN; }

	bool CanHandoff() const {
		const Tick until = deadline.load();
		return until == OPEN || Clock::now().time_since_epoch().count() < until;
	}

	// Only the owning environment submits sends or starts close.
	void Close(Clock::duration grace) {
		deadline.store((Clock::now() + grace).time_since_epoch().count());
	}

	void WaitForHandoff() {
		std::unique_lock lock(completionMutex);
		const auto until = Clock::time_point(Clock::duration(deadline.load()));
		completed.wait_until(lock, until, [&]() { return pending.load() == 0; });
	}
};

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
