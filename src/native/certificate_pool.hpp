#pragma once

#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <utility>

#include "certificate.hpp"

namespace webrtc_node {

// Keeps a few default certificates ready on a background thread so creating a
// peer connection does not generate a key on the JavaScript thread. Each spare
// is handed out once, so every connection still gets its own certificate.
class CertificatePool {
	using Clock = std::chrono::steady_clock;
	struct Spare {
		CertificateMaterial material;
		Clock::time_point created;
	};

	static constexpr size_t CAPACITY = 4;
	// Spares are discarded before their validity period shrinks noticeably.
	static constexpr auto MAX_AGE = std::chrono::hours(1);

	std::function<CertificateMaterial()> generate;
	std::mutex mutex;
	std::condition_variable wake;
	std::deque<Spare> spares;
	std::thread worker;
	bool stopped = false;
	bool failed = false;

	void Run() {
		for (;;) {
			{
				std::unique_lock lock(mutex);
				wake.wait(lock, [&]() { return stopped || spares.size() < CAPACITY; });
				if (stopped)
					return;
			}
			Spare spare;
			try {
				spare.material = generate();
			} catch (...) {
				// Callers keep generating synchronously, which reports the error.
				std::lock_guard lock(mutex);
				failed = true;
				return;
			}
			spare.created = Clock::now();
			std::lock_guard lock(mutex);
			if (stopped)
				return;
			spares.push_back(std::move(spare));
		}
	}

public:
	explicit CertificatePool(std::function<CertificateMaterial()> generate_)
	    : generate(std::move(generate_)) {}
	CertificatePool(const CertificatePool &) = delete;
	CertificatePool &operator=(const CertificatePool &) = delete;
	~CertificatePool() { Stop(); }

	// Returns a fresh certificate, generating one here when no spare is ready.
	CertificateMaterial Take() {
		{
			std::lock_guard lock(mutex);
			const auto now = Clock::now();
			while (!spares.empty() && now - spares.front().created > MAX_AGE)
				spares.pop_front();
			if (!stopped && !failed && !worker.joinable()) {
				try {
					worker = std::thread([this]() { Run(); });
				} catch (...) {
					failed = true;
				}
			}
			if (!spares.empty()) {
				CertificateMaterial material = std::move(spares.front().material);
				spares.pop_front();
				wake.notify_one();
				return material;
			}
			wake.notify_one();
		}
		return generate();
	}

	void Stop() {
		{
			std::lock_guard lock(mutex);
			stopped = true;
			spares.clear();
		}
		wake.notify_all();
		if (worker.joinable())
			worker.join();
	}
};

} // namespace webrtc_node
