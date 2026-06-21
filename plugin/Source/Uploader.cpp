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
    notify();
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
        juce::MessageManager::callAsync ([cb = onStateChanged] { if (cb) cb(); });
}

void Uploader::run()
{
    while (! threadShouldExit())
    {
        Job job;
        bool haveJob = false;
        {
            const juce::ScopedLock lock (queueLock);
            if (! queue.empty()) { job = queue.front(); haveJob = true; }
        }

        if (! haveJob)
        {
            setState (State::Idle);
            wait (-1);
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
            bool drop = false;
            {
                const juce::ScopedLock lock (queueLock);
                if (! queue.empty())
                {
                    queue.front().attempts++;
                    if (queue.front().attempts >= maxAttempts)
                    {
                        juce::Logger::writeToLog ("[Earshot] dropping job after "
                            + juce::String (maxAttempts) + " attempts: "
                            + queue.front().file.getFileName());
                        queue.pop_front();
                        drop = true;
                    }
                }
            }
            if (! drop)
                for (int i = 0; i < 50 && ! threadShouldExit(); ++i) wait (100);
        }
    }
}

// Direct-to-R2 upload flow. Three steps:
//   1. POST <backend>/takes/upload-url → { takeId, wavKey, uploadUrl }
//   2. PUT  the WAV bytes to uploadUrl (Cloudflare R2, no Render in the path)
//   3. POST <backend>/takes/upload-complete with the takeId
// Render only sees two tiny JSON requests. The big bytes go to R2 directly,
// which avoids Render Free's 100s request-timeout on large WAV uploads.
bool Uploader::postOne (const Job& job)
{
    if (! job.file.existsAsFile())
    {
        juce::Logger::writeToLog ("[Earshot] upload skipped, missing file: "
                                   + job.file.getFullPathName());
        const juce::ScopedLock lock (queueLock);
        if (! queue.empty()) queue.pop_front();
        return false;
    }

    // Idempotency key = the file's full path. Stable across retries.
    const auto idemKey = job.file.getFullPathName();

    juce::String token;
    { const juce::ScopedLock lock (tokenLock); token = authToken; }
    if (token.isEmpty())
    {
        setState (State::Failed, "not signed in");
        return false;
    }

    // ---------- Step 1: ask backend for a presigned URL ----------
    // endpoint = backendBase + "/takes". Append "/upload-url" and
    // "/upload-complete" rather than reaching into URL internals.
    const auto base = endpoint.toString (false);
    juce::URL beginUrl    (base + "/upload-url");
    juce::URL completeUrl (base + "/upload-complete");

    // Build a small JSON body via DynamicObject so escaping is correct.
    juce::DynamicObject::Ptr bodyObj = new juce::DynamicObject();
    bodyObj->setProperty ("project",     job.project);
    bodyObj->setProperty ("durationSec", job.durationSec);
    const auto bodyJson = juce::JSON::toString (juce::var (bodyObj.get()), false);

    juce::String beginHeaders;
    beginHeaders << "Content-Type: application/json\r\n"
                 << "Authorization: Bearer " << token << "\r\n"
                 << "X-Earshot-Idempotency: " << idemKey;

    juce::StringPairArray beginHeadersOut;
    int beginStatus = 0;
    auto beginStream = beginUrl
        .withPOSTData (bodyJson)
        .createInputStream (
            juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
                .withConnectionTimeoutMs (30000)
                .withExtraHeaders (beginHeaders)
                .withResponseHeaders (&beginHeadersOut)
                .withStatusCode (&beginStatus));

    if (beginStream == nullptr || beginStatus < 200 || beginStatus >= 300)
    {
        setState (State::Failed,
                  "begin failed (" + juce::String (beginStatus) + ")");
        juce::Logger::writeToLog ("[Earshot] upload-url failed status="
                                   + juce::String (beginStatus));
        return false;
    }
    auto beginBody = beginStream->readEntireStreamAsString();
    auto beginVar  = juce::JSON::parse (beginBody);
    auto* beginObj = beginVar.getDynamicObject();
    if (! beginObj)
    {
        setState (State::Failed, "begin: bad json");
        return false;
    }
    const auto takeId    = beginObj->getProperty ("takeId").toString();
    const auto wavKey    = beginObj->getProperty ("wavKey").toString();
    const auto uploadUrl = beginObj->getProperty ("uploadUrl").toString();
    const auto deduped   = bool (beginObj->getProperty ("deduped"));

    if (deduped)
    {
        // Server already has this take. Done.
        juce::Logger::writeToLog ("[Earshot] dedup hit, takeId=" + takeId);
        return true;
    }
    if (takeId.isEmpty() || uploadUrl.isEmpty())
    {
        setState (State::Failed, "begin: missing fields");
        return false;
    }

    // ---------- Step 2: PUT bytes to R2 directly ----------
    juce::MemoryBlock wavBlock;
    if (! job.file.loadFileAsData (wavBlock))
    {
        setState (State::Failed, "read file failed");
        return false;
    }

    juce::URL putUrl (uploadUrl);
    juce::StringPairArray putHeadersOut;
    int putStatus = 0;

    // withPOSTData(MemoryBlock) sends raw bytes — String would corrupt
    // binary data via UTF-8 validation.
    auto putStream = putUrl
        .withPOSTData (wavBlock)
        .createInputStream (
            juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
                .withConnectionTimeoutMs (300000) // 5 min — R2 doesn't time out
                .withExtraHeaders ("Content-Type: audio/wav")
                .withResponseHeaders (&putHeadersOut)
                .withStatusCode (&putStatus)
                .withHttpRequestCmd ("PUT"));

    if (putStream == nullptr) {
        setState (State::Failed, "r2 put: no stream");
        return false;
    }
    putStream->readEntireStreamAsString(); // drain

    if (putStatus < 200 || putStatus >= 300)
    {
        setState (State::Failed, "r2 put failed (" + juce::String (putStatus) + ")");
        juce::Logger::writeToLog ("[Earshot] r2 PUT failed status=" + juce::String (putStatus));
        return false;
    }

    // ---------- Step 3: tell backend the upload finished ----------
    juce::DynamicObject::Ptr completeObj = new juce::DynamicObject();
    completeObj->setProperty ("takeId",          takeId);
    completeObj->setProperty ("wavKey",          wavKey);
    completeObj->setProperty ("project",         job.project);
    completeObj->setProperty ("durationSec",     job.durationSec);
    completeObj->setProperty ("bytes",           (juce::int64) wavBlock.getSize());
    completeObj->setProperty ("idempotencyKey",  idemKey);
    const auto completeBody = juce::JSON::toString (juce::var (completeObj.get()), false);

    juce::String completeHeaders;
    completeHeaders << "Content-Type: application/json\r\n"
                    << "Authorization: Bearer " << token;

    juce::StringPairArray completeHeadersOut;
    int completeStatus = 0;
    auto completeStream = completeUrl
        .withPOSTData (completeBody)
        .createInputStream (
            juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
                .withConnectionTimeoutMs (30000)
                .withExtraHeaders (completeHeaders)
                .withResponseHeaders (&completeHeadersOut)
                .withStatusCode (&completeStatus));

    if (completeStream == nullptr || completeStatus < 200 || completeStatus >= 300)
    {
        setState (State::Failed,
                  "complete failed (" + juce::String (completeStatus) + ")");
        juce::Logger::writeToLog ("[Earshot] upload-complete failed status="
                                   + juce::String (completeStatus));
        // R2 has the bytes; another retry will hit the idempotency-key
        // dedup and return success without re-uploading.
        return false;
    }

    completeStream->readEntireStreamAsString();
    juce::Logger::writeToLog ("[Earshot] uploaded ok takeId=" + takeId);
    return true;
}
