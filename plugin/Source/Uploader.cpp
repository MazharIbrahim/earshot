#include "Uploader.h"

Uploader::Uploader() : juce::Thread ("Earshot Uploader") {}

Uploader::~Uploader() { stop(); }

void Uploader::start()
{
    if (! isThreadRunning())
        startThread (juce::Thread::Priority::low);
}

void Uploader::stop()
{
    signalThreadShouldExit();
    notify();
    stopThread (3000);
}

void Uploader::enqueue (const juce::File& wav,
                        const juce::String& projectName,
                        double durationSec)
{
    {
        const juce::ScopedLock lock (queueLock);
        queue.push_back ({ wav, projectName, durationSec });
    }
    notify(); // wake the thread immediately
    if (onStateChanged) onStateChanged();
}

int Uploader::getQueueDepth() const
{
    const juce::ScopedLock lock (queueLock);
    return (int) queue.size();
}

juce::String Uploader::getLastError() const
{
    const juce::ScopedLock lock (errorLock);
    return lastError;
}

void Uploader::setState (State s, const juce::String& err)
{
    state.store (s);
    {
        const juce::ScopedLock lock (errorLock);
        lastError = err;
    }
    if (onStateChanged)
    {
        juce::MessageManager::callAsync ([cb = onStateChanged] { if (cb) cb(); });
    }
}

void Uploader::run()
{
    while (! threadShouldExit())
    {
        Job job;
        bool haveJob = false;
        {
            const juce::ScopedLock lock (queueLock);
            if (! queue.empty())
            {
                job = queue.front();
                haveJob = true;
            }
        }

        if (! haveJob)
        {
            setState (State::Idle);
            wait (-1); // sleep until notified
            continue;
        }

        setState (State::Uploading);
        const bool ok = postOne (job);

        if (ok)
        {
            const juce::ScopedLock lock (queueLock);
            if (! queue.empty()) queue.pop_front();
        }
        else
        {
            // Retry with backoff. Don't pop; we'll try again.
            for (int i = 0; i < 50 && ! threadShouldExit(); ++i)
                wait (100);
        }
    }
}

bool Uploader::postOne (const Job& job)
{
    if (! job.file.existsAsFile())
    {
        juce::Logger::writeToLog ("[Earshot] upload skipped, missing file: "
                                   + job.file.getFullPathName());
        // Drop the job — file is gone.
        const juce::ScopedLock lock (queueLock);
        if (! queue.empty()) queue.pop_front();
        return false;
    }

    juce::URL url = endpoint
        .withParameter ("project",     job.project)
        .withParameter ("durationSec", juce::String (job.durationSec, 3))
        .withFileToUpload ("audio", job.file, "audio/wav");

    juce::StringPairArray responseHeaders;
    int statusCode = 0;

    auto stream = url.createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
            .withConnectionTimeoutMs (15000)
            .withResponseHeaders (&responseHeaders)
            .withStatusCode (&statusCode));

    if (stream == nullptr)
    {
        setState (State::Failed, "could not connect");
        juce::Logger::writeToLog ("[Earshot] upload connect failed for "
                                   + job.file.getFileName());
        return false;
    }

    auto body = stream->readEntireStreamAsString();

    if (statusCode >= 200 && statusCode < 300)
    {
        juce::Logger::writeToLog ("[Earshot] uploaded " + job.file.getFileName()
                                   + " status=" + juce::String (statusCode)
                                   + " body=" + body);
        return true;
    }

    setState (State::Failed,
              "server " + juce::String (statusCode));
    juce::Logger::writeToLog ("[Earshot] upload failed " + job.file.getFileName()
                               + " status=" + juce::String (statusCode)
                               + " body=" + body);
    return false;
}
