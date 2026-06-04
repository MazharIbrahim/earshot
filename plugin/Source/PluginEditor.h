#pragma once

#include <JuceHeader.h>
#include "PluginProcessor.h"
#include "BrandLookAndFeel.h"

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

    EarshotAudioProcessor& processorRef;
    BrandLookAndFeel lnf;

    juce::Label  wordmark;
    juce::Label  projectLabel;
    juce::Label  liveLabel;
    juce::TextButton snapshotButton { "snapshot" };
    juce::TextButton qrButton       { "qr" };
    juce::Label  takesHeader;
    juce::Label  takesPlaceholder;
    juce::Label  accountChip;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EarshotAudioProcessorEditor)
};
