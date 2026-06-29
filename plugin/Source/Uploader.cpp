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

// Helper: small JSON POST with auth + idempotency. Returns parsed body.
static juce::var jsonPost (const juce::URL& url,
                           const juce::String& body,
                           const juce::String& token,
                           const juce::String& idemHeader,
                           int* statusOut = nullptr,
                           int timeoutMs = 30000)
{
    juce::String hdr;
    hdr << "Content-Type: application/json\r\n"
        << "Authorization: Bearer " << token;
    if (idemHeader.isNotEmpty()) hdr << "\r\nX-Earshot-Idempotency: " << idemHeader;

    juce::StringPairArray respHeaders;
    int status = 0;
    auto stream = url.withPOSTData (body).createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
            .withConnectionTimeoutMs (timeoutMs)
            .withExtraHeaders (hdr)
            .withResponseHeaders (&respHeaders)
            .withStatusCode (&status));
    if (statusOut != nullptr) *statusOut = status;
    if (stream == nullptr) return {};
    return juce::JSON::parse (stream->readEntireStreamAsString());
}

// Direct-to-R2 multipart upload. Splits the WAV into 8 MB chunks; each
// chunk is its own presigned PUT. Single-PUT was hanging on bigger files
// over slow uplinks (NSURLSession + buffered 46 MB body + intermediate
// idle timeouts). Multipart fixes that AND gives us real progress.
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

    // Idempotency key — must be stable across retries of the same take
    // AND ASCII-safe (some HTTP middleware mangles spaces in headers).
    // The filename already encodes project + timestamp so it's unique;
    // strip everything but [A-Za-z0-9._-] and we're good.
    juce::String idemKey;
    for (auto c : job.file.getFileName())
    {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
            || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_')
            idemKey += juce::String::charToString (c);
        else
            idemKey += '_';
    }

    juce::String token;
    { const juce::ScopedLock lock (tokenLock); token = authToken; }
    if (token.isEmpty())
    {
        setState (State::Failed, "not signed in");
        return false;
    }

    // Reset per-job progress counters.
    progress.store (0.0f);
    currentJobTotalBytes.store ((juce::int64) job.file.getSize());
    currentJobUploadedBytes.store (0);

    // endpoint = backendBase + "/takes". Build multipart subpaths.
    const auto base = endpoint.toString (false);
    const juce::URL initUrl     (base + "/multipart/init");
    const juce::URL signUrl     (base + "/multipart/sign-part");
    const juce::URL completeUrl (base + "/multipart/complete");
    const juce::URL abortUrl    (base + "/multipart/abort");

    // ---------- Step 1: multipart init ----------
    juce::DynamicObject::Ptr initBody = new juce::DynamicObject();
    initBody->setProperty ("project",     job.project);
    initBody->setProperty ("durationSec", job.durationSec);

    int initStatus = 0;
    auto initVar = jsonPost (initUrl,
                             juce::JSON::toString (juce::var (initBody.get()), false),
                             token, idemKey, &initStatus);
    if (initStatus < 200 || initStatus >= 300)
    {
        setState (State::Failed, "init " + juce::String (initStatus));
        juce::Logger::writeToLog ("[Earshot] multipart init failed status=" + juce::String (initStatus));
        return false;
    }
    auto* initObj = initVar.getDynamicObject();
    if (! initObj) { setState (State::Failed, "init: bad json"); return false; }

    const auto takeId   = initObj->getProperty ("takeId").toString();
    const auto wavKey   = initObj->getProperty ("wavKey").toString();
    const auto uploadId = initObj->getProperty ("uploadId").toString();
    const auto partSize = (juce::int64) (int) initObj->getProperty ("partSize");
    const bool deduped  = bool (initObj->getProperty ("deduped"));
    if (deduped) { juce::Logger::writeToLog ("[Earshot] dedup hit"); return true; }
    if (takeId.isEmpty() || uploadId.isEmpty() || partSize <= 0)
    {
        setState (State::Failed, "init: missing fields");
        return false;
    }

    // ---------- Step 2: read file + upload each part ----------
    juce::MemoryBlock wavBlock;
    if (! job.file.loadFileAsData (wavBlock))
    {
        setState (State::Failed, "read file failed");
        return false;
    }
    const juce::int64 totalBytes = (juce::int64) wavBlock.getSize();
    currentJobTotalBytes.store (totalBytes);

    juce::Array<juce::var> partsForComplete;
    juce::int64 offset = 0;
    int partNumber = 0;
    while (offset < totalBytes)
    {
        if (threadShouldExit()) return false;
        ++partNumber;
        const juce::int64 thisSize = juce::jmin (partSize, totalBytes - offset);

        // Get a signed URL for this part.
        juce::DynamicObject::Ptr signBody = new juce::DynamicObject();
        signBody->setProperty ("wavKey",     wavKey);
        signBody->setProperty ("uploadId",   uploadId);
        signBody->setProperty ("partNumber", partNumber);

        int signStatus = 0;
        auto signVar = jsonPost (signUrl,
                                 juce::JSON::toString (juce::var (signBody.get()), false),
                                 token, {}, &signStatus);
        if (signStatus < 200 || signStatus >= 300)
        {
            setState (State::Failed, "sign " + juce::String (signStatus));
            juce::Logger::writeToLog ("[Earshot] sign-part " + juce::String (partNumber)
                                       + " failed status=" + juce::String (signStatus));
            return false;
        }
        auto* signObj = signVar.getDynamicObject();
        const auto partUrl = signObj ? signObj->getProperty ("url").toString() : juce::String();
        if (partUrl.isEmpty()) { setState (State::Failed, "sign: no url"); return false; }

        // PUT the chunk.
        juce::MemoryBlock chunk (static_cast<const char*> (wavBlock.getData()) + offset, (size_t) thisSize);
        juce::URL partPutUrl (partUrl);
        juce::StringPairArray respHeaders;
        int putStatus = 0;
        auto putStream = partPutUrl
            .withPOSTData (chunk)
            .createInputStream (
                juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (120000) // 2 min per 8 MB part
                    .withResponseHeaders (&respHeaders)
                    .withStatusCode (&putStatus)
                    .withHttpRequestCmd ("PUT"));

        if (putStream == nullptr || putStatus < 200 || putStatus >= 300)
        {
            setState (State::Failed, "part " + juce::String (partNumber)
                       + " failed (" + juce::String (putStatus) + ")");
            juce::Logger::writeToLog ("[Earshot] part " + juce::String (partNumber)
                                       + " PUT failed status=" + juce::String (putStatus));
            return false;
        }
        putStream->readEntireStreamAsString(); // drain

        // ETag from R2's response — strip quotes that S3-compatible APIs wrap it in.
        auto etag = respHeaders.getValue ("ETag", respHeaders.getValue ("etag", ""));
        etag = etag.unquoted();
        if (etag.isEmpty())
        {
            setState (State::Failed, "part " + juce::String (partNumber) + ": no etag");
            return false;
        }

        juce::DynamicObject::Ptr pe = new juce::DynamicObject();
        pe->setProperty ("partNumber", partNumber);
        pe->setProperty ("etag",       etag);
        partsForComplete.add (juce::var (pe.get()));

        offset += thisSize;
        currentJobUploadedBytes.store (offset);
        progress.store ((float) offset / (float) totalBytes);
        // Notify UI of progress.
        if (onStateChanged)
            juce::MessageManager::callAsync ([cb = onStateChanged] { if (cb) cb(); });

        juce::Logger::writeToLog ("[Earshot] part " + juce::String (partNumber)
                                   + "/" + juce::String ((totalBytes + partSize - 1) / partSize)
                                   + " ok (" + juce::String (offset / 1024) + " KB)");
    }

    // ---------- Step 3: complete the multipart upload ----------
    juce::DynamicObject::Ptr completeBody = new juce::DynamicObject();
    completeBody->setProperty ("takeId",         takeId);
    completeBody->setProperty ("wavKey",         wavKey);
    completeBody->setProperty ("uploadId",       uploadId);
    completeBody->setProperty ("parts",          partsForComplete);
    completeBody->setProperty ("project",        job.project);
    completeBody->setProperty ("durationSec",    job.durationSec);
    completeBody->setProperty ("bytes",          totalBytes);
    completeBody->setProperty ("idempotencyKey", idemKey);

    int completeStatus = 0;
    auto completeVar = jsonPost (completeUrl,
                                 juce::JSON::toString (juce::var (completeBody.get()), false),
                                 token, {}, &completeStatus, 60000);
    if (completeStatus < 200 || completeStatus >= 300)
    {
        setState (State::Failed, "complete " + juce::String (completeStatus));
        juce::Logger::writeToLog ("[Earshot] multipart complete failed status="
                                   + juce::String (completeStatus));
        return false;
    }

    juce::Logger::writeToLog ("[Earshot] uploaded ok takeId=" + takeId
                               + " parts=" + juce::String (partNumber));
    progress.store (1.0f);
    return true;
}
