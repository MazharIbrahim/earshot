#pragma once

#include <JuceHeader.h>
#include <atomic>

// Lock-free stereo float ring buffer for moving audio from the realtime
// thread (processBlock) to a background writer thread.
//
// Push: called from audio thread, never allocates, never blocks.
// Pop:  called from writer thread, copies into a destination buffer.
class CaptureBuffer
{
public:
    explicit CaptureBuffer (int capacityFrames = 1 << 18) // ~5.5 s @ 48 kHz
        : fifo (capacityFrames), storage (2, capacityFrames)
    {
        storage.clear();
    }

    // Realtime-safe. Returns frames actually pushed (may be less than n if full).
    int push (const float* left, const float* right, int n) noexcept
    {
        int start1, size1, start2, size2;
        fifo.prepareToWrite (n, start1, size1, start2, size2);

        if (size1 > 0)
        {
            juce::FloatVectorOperations::copy (storage.getWritePointer (0, start1), left,  size1);
            juce::FloatVectorOperations::copy (storage.getWritePointer (1, start1), right, size1);
        }
        if (size2 > 0)
        {
            juce::FloatVectorOperations::copy (storage.getWritePointer (0, start2), left  + size1, size2);
            juce::FloatVectorOperations::copy (storage.getWritePointer (1, start2), right + size1, size2);
        }

        fifo.finishedWrite (size1 + size2);
        return size1 + size2;
    }

    // Called by the writer thread. Returns frames written into dest.
    int pop (juce::AudioBuffer<float>& dest, int maxFrames) noexcept
    {
        const int available = fifo.getNumReady();
        const int n = juce::jmin (available, maxFrames, dest.getNumSamples());
        if (n <= 0) return 0;

        int start1, size1, start2, size2;
        fifo.prepareToRead (n, start1, size1, start2, size2);

        if (size1 > 0)
        {
            dest.copyFrom (0, 0, storage, 0, start1, size1);
            dest.copyFrom (1, 0, storage, 1, start1, size1);
        }
        if (size2 > 0)
        {
            dest.copyFrom (0, size1, storage, 0, start2, size2);
            dest.copyFrom (1, size1, storage, 1, start2, size2);
        }

        fifo.finishedRead (size1 + size2);
        return size1 + size2;
    }

    int  framesAvailable() const noexcept { return fifo.getNumReady(); }
    void reset() noexcept { fifo.reset(); }

private:
    juce::AbstractFifo fifo;
    juce::AudioBuffer<float> storage;

    JUCE_DECLARE_NON_COPYABLE (CaptureBuffer)
};
