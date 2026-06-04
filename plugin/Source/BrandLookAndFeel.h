#pragma once

#include <JuceHeader.h>

// Earshot brand tokens, mirrored from docs/brand.md.
namespace EarshotBrand
{
    inline const juce::Colour background { 0xff0e0e10 };
    inline const juce::Colour surface    { 0xff17171a };
    inline const juce::Colour text       { 0xffede9e2 };
    inline const juce::Colour textMuted  { 0xff7a7770 };
    inline const juce::Colour accent     { 0xffffb347 };
    inline const juce::Colour stroke     { 0xff2a2a2e };
}

class BrandLookAndFeel : public juce::LookAndFeel_V4
{
public:
    BrandLookAndFeel();

    juce::Font getTextButtonFont (juce::TextButton&, int buttonHeight) override;
    void drawButtonBackground (juce::Graphics&, juce::Button&,
                               const juce::Colour&, bool, bool) override;
};
