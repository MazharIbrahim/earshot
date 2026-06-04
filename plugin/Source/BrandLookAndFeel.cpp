#include "BrandLookAndFeel.h"

BrandLookAndFeel::BrandLookAndFeel()
{
    setColour (juce::ResizableWindow::backgroundColourId, EarshotBrand::background);
    setColour (juce::Label::textColourId,                  EarshotBrand::text);
    setColour (juce::TextButton::buttonColourId,           EarshotBrand::surface);
    setColour (juce::TextButton::buttonOnColourId,         EarshotBrand::accent);
    setColour (juce::TextButton::textColourOnId,           EarshotBrand::background);
    setColour (juce::TextButton::textColourOffId,          EarshotBrand::text);
}

juce::Font BrandLookAndFeel::getTextButtonFont (juce::TextButton&, int buttonHeight)
{
    return juce::Font (juce::Font::getDefaultMonospacedFontName(),
                       juce::jmin (16.0f, buttonHeight * 0.5f),
                       juce::Font::plain);
}

void BrandLookAndFeel::drawButtonBackground (juce::Graphics& g, juce::Button& button,
                                             const juce::Colour& /*backgroundColour*/,
                                             bool isHighlighted, bool isDown)
{
    auto bounds = button.getLocalBounds().toFloat().reduced (0.5f);
    auto fill = isDown ? EarshotBrand::accent.darker (0.2f)
              : isHighlighted ? EarshotBrand::accent
              : EarshotBrand::surface;

    g.setColour (fill);
    g.fillRoundedRectangle (bounds, 6.0f);

    g.setColour (EarshotBrand::stroke);
    g.drawRoundedRectangle (bounds, 6.0f, 1.0f);
}
