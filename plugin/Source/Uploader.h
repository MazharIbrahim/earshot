#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <deque>

// Background thread that POSTs finished WAV takes to the Earshot backend.
// Uses JUCE's URL API (no curl dependency). Currently targets a local
// dev server; the URL is a member so we can swap to the cloud endpoint.
class Uploader : public juce::Thread
{
public:
    enum class State { Idle, Uploading, Failed };

    Uploader();
    ~Uploader() override;

    void start();
    void stop();

    // Called from any thread. Owns the file (must exist on disk).
    void enqueue (const juce::File& wav,
                  const juce::String& projectName,
                  double durationSec);

    State        getState()    const { return state.load(); }
    juce::String getLastError() const;
    int          getQueueDepth() const;

    void setEndpoint (const juce::URL& url) { endpoint = url; }
    juce::URL getEndpoint() const { return endpoint; }

    void setAuthToken (const juce::String& tok)
    {
        const juce::ScopedLock lock (tokenLock);
        authToken = tok;
    }

    // Called on the message thread when state or queue changes.
    std::function<void()> onStateChanged;

private:
    struct Job
    {
        juce::File   file;
        juce::String project;
        double       durationSec;
        int          attempts { 0 };  // failures so far for this job
    };

    static constexpr int maxAttempts = 5;

    void run() override;
    bool postOne (const Job&);
    void setState (State s, const juce::String& err = {});

    juce::URL endpoint { "https://app.earshot.cc/takes" };

    juce::CriticalSection tokenLock;
    juce::String authToken;

    juce::CriticalSection queueLock;
    std::deque<Job> queue;

    std::atomic<State> state { State::Idle };

    juce::CriticalSection errorLock;
    juce::String lastError;

    JUCE_DECLARE_NON_COPYABLE (Uploader)
};
