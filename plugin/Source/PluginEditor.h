#pragma once

#include <JuceHeader.h>
#include "PluginProcessor.h"
#include "BrandLookAndFeel.h"
#include "TakeWriter.h"

class EarshotAudioProcessorEditor : public juce::AudioProcessorEditor,
                                    private juce::Timer
{
public:
    explicit EarshotAudioProcessorEditor (EarshotAudioProcessor&);
    ~EarshotAudioProcessorEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void refreshTakes();
    juce::String renderTakesText (const std::vector<TakeRecord>&) const;

    EarshotAudioProcessor& processorRef;
    BrandLookAndFeel lnf;

    juce::Label  wordmark;
    juce::Label  projectLabel;
    juce::Label  liveLabel;
    juce::TextButton snapshotButton { "snapshot" };
    juce::TextButton qrButton       { "qr" };
    juce::Label  takesHeader;
    juce::Label  takesBody;
    juce::Label  accountChip;

    int lastTakeCount { -1 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EarshotAudioProcessorEditor)
};
