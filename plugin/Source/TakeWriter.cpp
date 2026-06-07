#include "TakeWriter.h"

TakeWriter::TakeWriter (CaptureBuffer& buf)
    : juce::Thread ("Earshot Take Writer"), buffer (buf)
{
}

TakeWriter::~TakeWriter()
{
    stop();
}

void TakeWriter::start (double sr)
{
    sampleRate = sr;
    startThread (juce::Thread::Priority::normal);
}

void TakeWriter::stop()
{
    signalThreadShouldExit();
    notify();
    stopThread (2000);
    if (fileOpen) closeFile();
}

void TakeWriter::setProjectName (const juce::String& name)
{
    const juce::ScopedLock lock (projectNameLock);
    projectName = name.isEmpty() ? juce::String ("Untitled") : name;
}

std::vector<TakeRecord> TakeWriter::snapshotTakes() const
{
    const juce::ScopedLock lock (takesLock);
    return takes;
}

juce::File TakeWriter::takesRoot()
{
    auto root = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                    .getChildFile ("Earshot")
                    .getChildFile ("takes");
    root.createDirectory();
    return root;
}

void TakeWriter::openNewFile()
{
    juce::String projName;
    {
        const juce::ScopedLock lock (projectNameLock);
        projName = projectName;
    }

    auto safe = projName.replaceCharacters ("/\\:?*\"<>|", "_________");
    auto dir  = takesRoot().getChildFile (safe);
    dir.createDirectory();

    auto stamp = juce::Time::getCurrentTime().formatted ("%Y-%m-%d_%H-%M-%S");
    currentFile = dir.getChildFile (safe + "_" + stamp + ".wav");

    if (auto stream = std::unique_ptr<juce::FileOutputStream> (currentFile.createOutputStream()))
    {
        juce::WavAudioFormat fmt;
        writer.reset (fmt.createWriterFor (stream.get(),
                                           sampleRate,
                                           2,            // stereo
                                           16,           // bit depth (16-bit PCM)
                                           {},           // metadata
                                           0));          // quality (ignored for WAV)
        if (writer != nullptr)
        {
            stream.release(); // writer owns it now
            fileOpen = true;
            framesWritten = 0;
            juce::Logger::writeToLog ("[Earshot] take started: "
                                       + currentFile.getFullPathName()
                                       + " sr=" + juce::String (sampleRate, 1));
        }
        else
        {
            juce::Logger::writeToLog ("[Earshot] FAILED to create WAV writer for "
                                       + currentFile.getFullPathName());
        }
    }
    else
    {
        juce::Logger::writeToLog ("[Earshot] FAILED to open output stream for "
                                   + currentFile.getFullPathName());
    }
}

void TakeWriter::closeFile()
{
    if (! fileOpen) return;

    const double dur = framesWritten / sampleRate;
    writer.reset(); // flushes and closes
    fileOpen = false;

    juce::Logger::writeToLog ("[Earshot] take closed: "
                               + currentFile.getFullPathName()
                               + " frames=" + juce::String (framesWritten)
                               + " duration=" + juce::String (dur, 2) + "s"
                               + " size=" + juce::String (currentFile.getSize()) + "B");

    // Discard takes shorter than 1 second (transport bumps, etc.).
    if (dur < 1.0)
    {
        currentFile.deleteFile();
        return;
    }

    TakeRecord rec;
    rec.label       = juce::Time::getCurrentTime().formatted ("%b %-d, %-I:%M %p");
    rec.file        = currentFile;
    rec.durationSec = dur;
    rec.createdAt   = juce::Time::getCurrentTime();

    {
        const juce::ScopedLock lock (takesLock);
        takes.insert (takes.begin(), rec);
        if (takes.size() > 16) takes.resize (16);
    }

    if (onTakesChanged) onTakesChanged();
}

void TakeWriter::run()
{
    juce::AudioBuffer<float> scratch (2, 4096);

    while (! threadShouldExit())
    {
        const bool wantOpen = armed.load (std::memory_order_acquire);

        if (wantOpen && ! fileOpen) openNewFile();

        // Drain whatever is available.
        int got = buffer.pop (scratch, scratch.getNumSamples());
        if (got > 0 && fileOpen && writer != nullptr)
        {
            const float* chans[2] = { scratch.getReadPointer (0),
                                      scratch.getReadPointer (1) };
            writer->writeFromFloatArrays (chans, 2, got);
            framesWritten += got;
        }

        if (! wantOpen && fileOpen && buffer.framesAvailable() == 0)
            closeFile();

        if (got == 0)
            wait (20); // ~50 Hz polling when idle
    }
}
