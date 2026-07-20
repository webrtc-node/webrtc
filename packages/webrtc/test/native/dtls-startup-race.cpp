#include <rtc/rtc.hpp>

#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>

using namespace std::chrono_literals;

namespace {

struct ObservedState {
  std::mutex mutex;
  std::condition_variable changed;
  rtc::PeerConnection::State peer = rtc::PeerConnection::State::New;
  rtc::PeerConnection::IceState ice = rtc::PeerConnection::IceState::New;
  rtc::PeerConnection::GatheringState gathering = rtc::PeerConnection::GatheringState::New;
  bool channelOpen = false;
  bool everConnected = false;
  bool everFailed = false;
};

struct RemoteChannelHolder {
  std::mutex mutex;
  std::shared_ptr<rtc::DataChannel> channel;
};

template <typename Predicate>
bool waitFor(const std::shared_ptr<ObservedState> &state, std::chrono::milliseconds timeout,
             Predicate predicate) {
  std::unique_lock lock(state->mutex);
  return state->changed.wait_for(lock, timeout, [&] { return predicate(*state); });
}

void observe(rtc::PeerConnection &peerConnection, const std::shared_ptr<ObservedState> &state) {
  peerConnection.onStateChange([state](rtc::PeerConnection::State value) {
    {
      std::lock_guard lock(state->mutex);
      state->peer = value;
      state->everConnected = state->everConnected || value == rtc::PeerConnection::State::Connected;
      state->everFailed = state->everFailed || value == rtc::PeerConnection::State::Failed;
    }
    state->changed.notify_all();
  });
  peerConnection.onIceStateChange([state](rtc::PeerConnection::IceState value) {
    {
      std::lock_guard lock(state->mutex);
      state->ice = value;
    }
    state->changed.notify_all();
  });
  peerConnection.onGatheringStateChange([state](rtc::PeerConnection::GatheringState value) {
    {
      std::lock_guard lock(state->mutex);
      state->gathering = value;
    }
    state->changed.notify_all();
  });
}

std::string describe(const char *label, const std::shared_ptr<ObservedState> &state) {
  std::lock_guard lock(state->mutex);
  std::ostringstream output;
  output << label << "(peer=" << state->peer << ", ice=" << state->ice
         << ", gathering=" << state->gathering
         << ", channel-open=" << (state->channelOpen ? "true" : "false")
         << ", ever-connected=" << (state->everConnected ? "true" : "false")
         << ", ever-failed=" << (state->everFailed ? "true" : "false") << ')';
  return output.str();
}

rtc::Description corruptFingerprint(rtc::Description description) {
  auto fingerprint = description.fingerprint();
  if (!fingerprint || fingerprint->value.empty()) {
    throw std::runtime_error("answer has no fingerprint");
  }
  char &first = fingerprint->value.front();
  first = first == '0' ? '1' : '0';
  description.setFingerprint(*fingerprint);
  return description;
}

struct IterationResult {
  bool answererStartedChecks = false;
  bool setRemoteThrew = false;
  bool connected = false;
  std::string error;
};

IterationResult failed(std::string error) {
  IterationResult result;
  result.error = std::move(error);
  return result;
}

IterationResult runIteration(bool invalidFingerprint) {
  rtc::Configuration configuration;
  configuration.disableAutoNegotiation = true;
  configuration.forceMediaTransport = true;

  rtc::PeerConnection offerer(configuration);
  rtc::PeerConnection answerer(configuration);
  auto offererState = std::make_shared<ObservedState>();
  auto answererState = std::make_shared<ObservedState>();
  auto remoteChannel = std::make_shared<RemoteChannelHolder>();
  observe(offerer, offererState);
  observe(answerer, answererState);

  answerer.onDataChannel([answererState, remoteChannel](std::shared_ptr<rtc::DataChannel> channel) {
    channel->onOpen([answererState] {
      {
        std::lock_guard lock(answererState->mutex);
        answererState->channelOpen = true;
      }
      answererState->changed.notify_all();
    });
    std::lock_guard lock(remoteChannel->mutex);
    remoteChannel->channel = std::move(channel);
  });
  auto localChannel = offerer.createDataChannel("dtls-startup-race");
  localChannel->onOpen([offererState] {
    {
      std::lock_guard lock(offererState->mutex);
      offererState->channelOpen = true;
    }
    offererState->changed.notify_all();
  });

  auto finish = [&](IterationResult result) {
    offerer.close();
    answerer.close();
    return result;
  };

  offerer.setLocalDescription(rtc::Description::Type::Offer);
  if (!waitFor(offererState, 5s, [](const ObservedState &state) {
        return state.gathering == rtc::PeerConnection::GatheringState::Complete;
      })) {
    return finish(failed("offer gathering timed out"));
  }
  auto offer = offerer.localDescription();
  if (!offer || offer->candidates().empty()) {
    return finish(failed("full offer has no inline candidates"));
  }

  answerer.setRemoteDescription(*offer);
  answerer.setLocalDescription(rtc::Description::Type::Answer);
  if (!waitFor(answererState, 5s, [](const ObservedState &state) {
        return state.gathering == rtc::PeerConnection::GatheringState::Complete;
      })) {
    return finish(failed("answer gathering timed out"));
  }
  auto answer = answerer.localDescription();
  if (!answer || answer->candidates().empty()) {
    return finish(failed("full answer has no inline candidates"));
  }

  IterationResult result;
  result.answererStartedChecks = waitFor(answererState, 500ms, [](const ObservedState &state) {
    return state.ice != rtc::PeerConnection::IceState::New;
  });
  if (!result.answererStartedChecks) {
    result.error = "answerer did not start ICE checks before delayed answer application";
    return finish(std::move(result));
  }
  std::this_thread::sleep_for(50ms);

  try {
    offerer.setRemoteDescription(invalidFingerprint ? corruptFingerprint(*answer) : *answer);
  } catch (const std::exception &exception) {
    result.setRemoteThrew = true;
    result.error = exception.what();
    return finish(std::move(result));
  }

  if (invalidFingerprint) {
    const bool completed = waitFor(offererState, 5s, [](const ObservedState &state) {
      return state.everConnected || state.everFailed;
    });
    std::lock_guard lock(offererState->mutex);
    result.connected = offererState->everConnected;
    if (result.connected) result.error = "invalid fingerprint connected";
    else if (!completed || !offererState->everFailed)
      result.error = "invalid fingerprint did not fail authentication";
  } else {
    waitFor(offererState, 10s, [](const ObservedState &state) {
      return (state.everConnected && state.channelOpen) || state.everFailed ||
             state.peer == rtc::PeerConnection::State::Disconnected ||
             state.peer == rtc::PeerConnection::State::Closed;
    });
    {
      std::lock_guard lock(offererState->mutex);
      result.connected = offererState->everConnected && offererState->channelOpen;
    }
    if (!result.connected) {
      result.error = "valid full answer did not connect; " + describe("offerer", offererState) +
                     "; " + describe("answerer", answererState);
    }
  }

  return finish(std::move(result));
}

}  // namespace

int main(int argc, char **argv) {
  const int iterations = argc > 1 ? std::atoi(argv[1]) : 100;
  const bool invalidFingerprint = argc > 2 && std::string(argv[2]) == "invalid";
  if (iterations <= 0) {
    std::cerr << "iterations must be positive\n";
    return 2;
  }

  if (!invalidFingerprint) rtc::InitLogger(rtc::LogLevel::Error);
  rtc::SetThreadPoolSize(4);
  int failures = 0;
  int checksStarted = 0;
  for (int index = 0; index < iterations; ++index) {
    try {
      const auto result = runIteration(invalidFingerprint);
      checksStarted += result.answererStartedChecks ? 1 : 0;
      if (result.setRemoteThrew || !result.error.empty()) {
        ++failures;
        std::cerr << "iteration " << index + 1 << ": "
                  << (result.error.empty() ? "setRemoteDescription threw" : result.error) << '\n';
      }
    } catch (const std::exception &exception) {
      ++failures;
      std::cerr << "iteration " << index + 1 << ": unexpected exception: " << exception.what()
                << '\n';
    }
  }

  rtc::Cleanup().wait();
  std::cout << "mode=" << (invalidFingerprint ? "invalid-fingerprint" : "valid")
            << " iterations=" << iterations << " failures=" << failures
            << " answerer-checks-started=" << checksStarted << '\n';
  return failures == 0 ? 0 : 1;
}
