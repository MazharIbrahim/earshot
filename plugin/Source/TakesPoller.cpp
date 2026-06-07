#include "TakesPoller.h"

TakesPoller::TakesPoller() : juce::Thread ("Earshot Takes Poller") {}

TakesPoller::~TakesPoller() { stop(); }

void TakesPoller::start()
{
    if (! isThreadRunning())
        startThread (juce::Thread::Priority::background);
}

void TakesPoller::stop()
{
    signalThreadShouldExit();
    notify();
    stopThread (2000);
}

void TakesPoller::setBackendBase (const juce::URL& url)
{
    backendBase = url;
    notify();
}

void TakesPoller::setProjectSlug (const juce::String& slug)
{
    {
        const juce::ScopedLock lock (slugLock);
        if (projectSlug == slug) return;
        projectSlug = slug;
        // Clear stale takes immediately — the UI shouldn't show takes from
        // the previous project while we wait for the next poll.
        const juce::ScopedLock t (takesLock);
        takes.clear();
    }
    if (onTakesChanged)
        juce::MessageManager::callAsync ([cb = onTakesChanged] { if (cb) cb(); });
    notify();
}

std::vector<TakesPoller::CloudTake> TakesPoller::getTakes() const
{
    const juce::ScopedLock lock (takesLock);
    return takes;
}

void TakesPoller::requestDelete (const juce::String& id)
{
    {
        const juce::ScopedLock lock (deleteLock);
        pendingDeletes.push_back (id);
    }
    // Optimistic local removal.
    {
        const juce::ScopedLock lock (takesLock);
        takes.erase (std::remove_if (takes.begin(), takes.end(),
                                     [&] (const CloudTake& t) { return t.id == id; }),
                     takes.end());
    }
    if (onTakesChanged)
        juce::MessageManager::callAsync ([cb = onTakesChanged] { if (cb) cb(); });
    notify();
}

void TakesPoller::run()
{
    while (! threadShouldExit())
    {
        // Drain delete queue first so user-initiated actions feel snappy.
        std::vector<juce::String> toDelete;
        {
            const juce::ScopedLock lock (deleteLock);
            toDelete.swap (pendingDeletes);
        }
        for (auto& id : toDelete)
            doDelete (id);

        poll();
        wait (5000);
    }
}

void TakesPoller::poll()
{
    juce::String slug;
    {
        const juce::ScopedLock lock (slugLock);
        slug = projectSlug;
    }
    if (slug.isEmpty()) return;

    auto url = backendBase.getChildURL ("projects").getChildURL (slug).getChildURL ("takes");
    int statusCode = 0;
    juce::StringPairArray headers;

    auto stream = url.createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs (3000)
            .withResponseHeaders (&headers)
            .withStatusCode (&statusCode));

    if (stream == nullptr || statusCode != 200) return;

    auto body = stream->readEntireStreamAsString();
    auto json = juce::JSON::parse (body);
    auto* arr = json.getArray();
    if (arr == nullptr) return;

    std::vector<CloudTake> next;
    next.reserve ((size_t) arr->size());
    for (auto& v : *arr)
    {
        if (auto* obj = v.getDynamicObject())
        {
            CloudTake t;
            t.id          = obj->getProperty ("id").toString();
            t.note        = obj->getProperty ("note").toString();
            t.durationSec = (double) obj->getProperty ("durationSec");
            t.createdAtMs = (juce::int64) obj->getProperty ("createdAt");
            next.push_back (std::move (t));
        }
    }

    bool changed = false;
    {
        const juce::ScopedLock lock (takesLock);
        if (next.size() != takes.size())
        {
            changed = true;
        }
        else
        {
            for (size_t i = 0; i < next.size(); ++i)
                if (takes[i].id != next[i].id || takes[i].note != next[i].note)
                { changed = true; break; }
        }
        if (changed) takes = std::move (next);
    }

    if (changed && onTakesChanged)
        juce::MessageManager::callAsync ([cb = onTakesChanged] { if (cb) cb(); });
}

void TakesPoller::doDelete (const juce::String& id)
{
    auto url = backendBase.getChildURL ("takes").getChildURL (id);
    int statusCode = 0;
    juce::StringPairArray headers;

    // JUCE's URL has no built-in DELETE verb; use httpRequestCmd to override.
    auto stream = url.createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs (5000)
            .withResponseHeaders (&headers)
            .withStatusCode (&statusCode)
            .withHttpRequestCmd ("DELETE"));

    if (stream != nullptr) stream->readEntireStreamAsString(); // drain
    juce::Logger::writeToLog ("[Earshot] DELETE /takes/" + id
                               + " status=" + juce::String (statusCode));
}
