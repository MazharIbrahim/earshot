#pragma once

#include <JuceHeader.h>
#include <atomic>

// Polls the backend for the cloud list of takes belonging to the current
// project. The plugin uses this so its list matches the website exactly —
// including takes recorded in previous sessions and edits made on the
// phone. Also handles DELETE requests in the background.
class TakesPoller : public juce::Thread
{
public:
    struct CloudTake
    {
        juce::String id;
        juce::String note;        // editable label from the website
        double       durationSec { 0.0 };
        juce::int64  createdAtMs { 0 };
    };

    TakesPoller();
    ~TakesPoller() override;

    void start();
    void stop();

    void setBackendBase   (const juce::URL& url);
    void setProjectSlug   (const juce::String& slug);
    void setAuthToken (const juce::String& tok)
    {
        const juce::ScopedLock lock (tokenLock);
        authToken = tok;
    }

    std::vector<CloudTake> getTakes() const;

    // Fire-and-forget DELETE. Optimistically removes from the local list so
    // the UI updates instantly; the next poll re-syncs.
    void requestDelete (const juce::String& id);

    // Fire-and-forget rename via PATCH /takes/:id { note }. Optimistic.
    void requestRename (const juce::String& id, const juce::String& newName);

    std::function<void()> onTakesChanged;

private:
    void run() override;
    void poll();
    void doDelete (const juce::String& id);
    void doRename (const juce::String& id, const juce::String& newName);

    juce::URL backendBase { "https://app.earshot.cc" };

    juce::CriticalSection slugLock;
    juce::String projectSlug;

    juce::CriticalSection takesLock;
    std::vector<CloudTake> takes;

    juce::CriticalSection tokenLock;
    juce::String authToken;

    // Pending delete requests. Drained by run() so HTTP I/O happens off
    // the message thread.
    juce::CriticalSection deleteLock;
    std::vector<juce::String> pendingDeletes;

    juce::CriticalSection renameLock;
    std::vector<std::pair<juce::String, juce::String>> pendingRenames;

    JUCE_DECLARE_NON_COPYABLE (TakesPoller)
};
