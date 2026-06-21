#include "PluginEditor.h"

extern "C" {
#include "qrcodegen.h"
}

using namespace EarshotBrand;

static juce::Font monoFont (float height, juce::Font::FontStyleFlags style = juce::Font::plain)
{
    return juce::Font (juce::Font::getDefaultMonospacedFontName(), height, style);
}

static juce::String formatRelative (juce::int64 ms)
{
    const auto diffSec = (juce::Time::getCurrentTime().toMilliseconds() - ms) / 1000;
    if (diffSec < 60)    return juce::String (diffSec) + "s ago";
    if (diffSec < 3600)  return juce::String (diffSec / 60) + "m ago";
    if (diffSec < 86400) return juce::String (diffSec / 3600) + "h ago";
    return juce::String (diffSec / 86400) + "d ago";
}

static juce::String formatDuration (double sec)
{
    const int s = (int) sec;
    return juce::String (s / 60) + ":" + juce::String (s % 60).paddedLeft ('0', 2);
}

// Matches backend slug(); kept here too so editor-side display logic stays
// independent of the processor.
static juce::String slugify (const juce::String& s)
{
    juce::String out;
    bool lastDash = true;
    for (auto cp : s.toLowerCase())
    {
        bool alnum = (cp >= 'a' && cp <= 'z') || (cp >= '0' && cp <= '9');
        if (alnum) { out += juce::String::charToString (cp); lastDash = false; }
        else if (! lastDash) { out += '-'; lastDash = true; }
    }
    while (out.endsWithChar ('-')) out = out.dropLastCharacters (1);
    return out.isEmpty() ? juce::String ("untitled") : out;
}

//==============================================================================
void LevelMeter::paint (juce::Graphics& g)
{
    auto bounds = getLocalBounds().toFloat();
    const float gap = 4.0f;
    const float w = (bounds.getWidth() - gap) * 0.5f;

    auto drawBar = [&] (juce::Rectangle<float> r, float level)
    {
        g.setColour (surface);
        g.fillRoundedRectangle (r, 2.0f);

        const float lvl = juce::jlimit (0.0f, 1.0f, level);
        if (lvl > 0.001f)
        {
            auto fill = r.withWidth (r.getWidth() * lvl);
            juce::Colour c = lvl > 0.85f ? juce::Colour (0xffff5a3c) : accent;
            g.setColour (c);
            g.fillRoundedRectangle (fill, 2.0f);
        }
    };

    drawBar (bounds.removeFromLeft (w), levelL);
    bounds.removeFromLeft (gap);
    drawBar (bounds, levelR);
}

//==============================================================================
void TakesListComponent::paint (juce::Graphics& g)
{
    if (takes.empty())
    {
        g.setColour (textMuted);
        g.setFont (monoFont (12.0f));
        g.drawText (juce::String::fromUTF8 ("no takes yet — hit record while playing."),
                    getLocalBounds(), juce::Justification::topLeft, false);
        return;
    }

    int y = 0;
    for (size_t i = 0; i < takes.size() && y + rowHeight <= getHeight(); ++i)
    {
        const auto& t = takes[i];
        auto rowR = juce::Rectangle<int> (0, y, getWidth(), rowHeight);

        // delete button hit area on the right
        auto delR = rowR.removeFromRight (deleteButtonWidth);
        g.setColour (textMuted);
        g.setFont (monoFont (14.0f));
        g.drawText ("x", delR, juce::Justification::centred, false);

        // label (note or timestamp)
        juce::String label = t.note.isNotEmpty()
            ? t.note
            : juce::Time (t.createdAtMs).formatted ("%b %-d, %-I:%M %p");

        g.setColour (text);
        g.setFont (monoFont (12.0f));
        g.drawText (label, rowR.removeFromLeft (rowR.getWidth() - 70),
                    juce::Justification::centredLeft, true);

        // duration + relative time
        g.setColour (textMuted);
        g.setFont (monoFont (10.0f));
        juce::String meta = formatDuration (t.durationSec)
                            + juce::String::fromUTF8 (" · ")
                            + formatRelative (t.createdAtMs);
        g.drawText (meta, rowR, juce::Justification::centredRight, false);

        y += rowHeight;
        g.setColour (stroke);
        g.drawLine (0.0f, (float) y, (float) getWidth(), (float) y, 1.0f);
    }
}

void TakesListComponent::mouseDown (const juce::MouseEvent& e)
{
    const int row = e.y / rowHeight;
    if (row < 0 || row >= (int) takes.size()) return;
    // Delete only if the click was inside the delete column.
    if (e.x >= getWidth() - deleteButtonWidth)
    {
        const auto id = takes[(size_t) row].id;
        const auto label = takes[(size_t) row].note;
        const auto prompt = label.isNotEmpty()
            ? juce::String ("Delete \"") + label + "\"?"
            : juce::String ("Delete this take?");

        juce::AlertWindow::showAsync (
            juce::MessageBoxOptions()
                .withIconType (juce::MessageBoxIconType::WarningIcon)
                .withTitle ("Delete take")
                .withMessage (prompt + "\n\nThis cannot be undone.")
                .withButton ("Delete")
                .withButton ("Cancel"),
            [this, id] (int result)
            {
                if (result == 1 && onDelete) onDelete (id);
            });
    }
}

//==============================================================================
void QrOverlay::setUrl (const juce::String& url)
{
    urlText = url;

    // Build QR code with nayuki's encoder. Medium error correction is a
    // good balance for laptop screen photos taken in mixed lighting.
    std::vector<uint8_t> qrBuf (qrcodegen_BUFFER_LEN_MAX);
    std::vector<uint8_t> tmpBuf (qrcodegen_BUFFER_LEN_MAX);

    bool ok = qrcodegen_encodeText (url.toRawUTF8(),
                                    tmpBuf.data(), qrBuf.data(),
                                    qrcodegen_Ecc_MEDIUM,
                                    qrcodegen_VERSION_MIN,
                                    qrcodegen_VERSION_MAX,
                                    qrcodegen_Mask_AUTO, true);
    if (! ok) { qrSize = 0; qr.clear(); repaint(); return; }

    qrSize = qrcodegen_getSize (qrBuf.data());
    qr.assign ((size_t) qrSize * (size_t) qrSize, 0);
    for (int y = 0; y < qrSize; ++y)
        for (int x = 0; x < qrSize; ++x)
            qr[(size_t)(y * qrSize + x)] = qrcodegen_getModule (qrBuf.data(), x, y) ? 1 : 0;
    repaint();
}

void QrOverlay::paint (juce::Graphics& g)
{
    // Dim backdrop.
    g.fillAll (juce::Colour (0xee0a0a0c));

    auto bounds = getLocalBounds().reduced (24);

    // White card behind the QR for max contrast.
    const int side = juce::jmin (bounds.getWidth(), bounds.getHeight() - 80);
    auto card = juce::Rectangle<int> (0, 0, side, side)
                    .withCentre ({ getWidth() / 2, getHeight() / 2 - 28 });
    g.setColour (juce::Colours::white);
    g.fillRoundedRectangle (card.toFloat().expanded (12.0f), 14.0f);

    // Draw QR modules.
    if (qrSize > 0)
    {
        const float modulePx = (float) side / (float) qrSize;
        g.setColour (juce::Colours::black);
        for (int y = 0; y < qrSize; ++y)
            for (int x = 0; x < qrSize; ++x)
                if (qr[(size_t)(y * qrSize + x)])
                    g.fillRect (card.getX() + (int) (x * modulePx),
                                card.getY() + (int) (y * modulePx),
                                (int) std::ceil (modulePx),
                                (int) std::ceil (modulePx));
    }

    // URL caption below.
    auto caption = juce::Rectangle<int> (0, card.getBottom() + 18, getWidth(), 36);
    g.setColour (text);
    g.setFont (monoFont (12.0f));
    auto display = urlText.startsWith ("https://") ? urlText.substring (8)
                 : urlText.startsWith ("http://")  ? urlText.substring (7)
                 : urlText;
    g.drawText (display, caption, juce::Justification::centred, false);

    g.setColour (textMuted);
    g.setFont (monoFont (10.0f));
    g.drawText ("tap anywhere to close", caption.translated (0, 18),
                juce::Justification::centred, false);
}

//==============================================================================
EarshotAudioProcessorEditor::EarshotAudioProcessorEditor (EarshotAudioProcessor& p)
    : AudioProcessorEditor (&p), processorRef (p)
{
    setLookAndFeel (&lnf);
    setSize (380, 520);

    wordmark.setText ("EARSHOT", juce::dontSendNotification);
    wordmark.setFont (monoFont (13.0f, juce::Font::bold));
    wordmark.setColour (juce::Label::textColourId, textMuted);
    wordmark.setJustificationType (juce::Justification::centredLeft);
    addAndMakeVisible (wordmark);

    projectLabel.setText (processorRef.getProjectName(), juce::dontSendNotification);
    projectLabel.setFont (monoFont (18.0f, juce::Font::bold));
    projectLabel.setColour (juce::Label::textColourId, text);
    projectLabel.setEditable (false, true, false);
    projectLabel.onTextChange = [this] { processorRef.setProjectName (projectLabel.getText()); };
    addAndMakeVisible (projectLabel);

    statusLabel.setText ("idle", juce::dontSendNotification);
    statusLabel.setFont (monoFont (11.0f));
    statusLabel.setColour (juce::Label::textColourId, textMuted);
    statusLabel.setJustificationType (juce::Justification::centredRight);
    addAndMakeVisible (statusLabel);

    addAndMakeVisible (meter);

    recButton.onClick = [this]
    {
        processorRef.setArmed (! processorRef.isArmed());
        updateRecButton();
    };
    addAndMakeVisible (recButton);

    openPhoneButton.onClick = [this]
    {
        if (processorRef.getAuthToken().isEmpty())
        {
            // No token → start device-link flow.
            signInFlow.start (juce::URL (processorRef.getBackendBase()));
        }
        else
        {
            // Signed in → just deep-link to the project page on the phone.
            auto base = processorRef.getBackendBase();
            auto deepLink = base + "/p/" + slugify (processorRef.getProjectName());
            showQrFor (deepLink);
        }
    };
    addAndMakeVisible (openPhoneButton);

    signInFlow.onLinked = [this] (const juce::String& token)
    {
        processorRef.setAuthToken (token);
        qrOverlay.setVisible (false);
        // Force a refresh on every poller now that we have auth.
        refreshTakes();
        refreshPublicUrl();
    };
    signInFlow.onExpired = [this]
    {
        qrOverlay.setVisible (false);
    };
    signInFlow.onError = [this] (const juce::String&)
    {
        qrOverlay.setVisible (false);
    };

    takesHeader.setText ("recent takes", juce::dontSendNotification);
    takesHeader.setFont (monoFont (11.0f));
    takesHeader.setColour (juce::Label::textColourId, textMuted);
    addAndMakeVisible (takesHeader);

    takesList.onDelete = [this] (const juce::String& id)
    {
        processorRef.getTakesPoller().requestDelete (id);
    };
    addAndMakeVisible (takesList);

    urlPrompt.setText ("mobile preview", juce::dontSendNotification);
    urlPrompt.setFont (monoFont (11.0f));
    urlPrompt.setColour (juce::Label::textColourId, textMuted);
    addAndMakeVisible (urlPrompt);

    urlValue.setText ("connecting…", juce::dontSendNotification);
    urlValue.setFont (monoFont (11.0f));
    urlValue.setColour (juce::Label::textColourId, accent);
    addAndMakeVisible (urlValue);

    copyButton.onClick = [this]
    {
        auto url = processorRef.getHealthPoller().getPublicUrl();
        if (url.isNotEmpty()) juce::SystemClipboard::copyTextToClipboard (url);
    };
    addAndMakeVisible (copyButton);

    addChildComponent (qrOverlay); // hidden until shown

    processorRef.getTakesPoller().onTakesChanged = [this]
    {
        juce::MessageManager::callAsync ([sp = juce::Component::SafePointer<EarshotAudioProcessorEditor> (this)]
        { if (sp != nullptr) sp->refreshTakes(); });
    };

    processorRef.getUploader().onStateChanged = [this]
    {
        juce::MessageManager::callAsync ([sp = juce::Component::SafePointer<EarshotAudioProcessorEditor> (this)]
        { if (sp != nullptr) sp->refreshUploadStatus(); });
    };

    processorRef.getHealthPoller().onUrlChanged = [this]
    {
        juce::MessageManager::callAsync ([sp = juce::Component::SafePointer<EarshotAudioProcessorEditor> (this)]
        { if (sp != nullptr) sp->refreshPublicUrl(); });
    };

    refreshTakes();
    updateRecButton();
    refreshUploadStatus();
    refreshPublicUrl();
    startTimerHz (12); // smooth meter; takes list is event-driven
}

EarshotAudioProcessorEditor::~EarshotAudioProcessorEditor()
{
    processorRef.getTakesPoller().onTakesChanged = nullptr;
    processorRef.getUploader().onStateChanged    = nullptr;
    processorRef.getHealthPoller().onUrlChanged  = nullptr;
    setLookAndFeel (nullptr);
}

void EarshotAudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (background);
    auto sep = getLocalBounds().reduced (16, 0).withHeight (1).withY (242);
    g.setColour (stroke);
    g.fillRect (sep);
}

void EarshotAudioProcessorEditor::resized()
{
    auto r = getLocalBounds().reduced (16);

    auto topBar = r.removeFromTop (24);
    wordmark.setBounds (topBar.removeFromLeft (90));
    statusLabel.setBounds (topBar.removeFromRight (200));

    r.removeFromTop (8);
    projectLabel.setBounds (r.removeFromTop (28));

    r.removeFromTop (12);
    meter.setBounds (r.removeFromTop (10));

    r.removeFromTop (16);
    recButton.setBounds (r.removeFromTop (52));

    r.removeFromTop (10);
    openPhoneButton.setBounds (r.removeFromTop (32));

    r.removeFromTop (20);
    takesHeader.setBounds (r.removeFromTop (16));
    r.removeFromTop (6);
    auto takesArea = r.removeFromTop (180);
    takesList.setBounds (takesArea);

    // Footer.
    auto footer = r.removeFromBottom (44);
    urlPrompt.setBounds (footer.removeFromTop (14));
    auto urlRow = footer.removeFromTop (24);
    copyButton.setBounds (urlRow.removeFromRight (56));
    urlRow.removeFromRight (8);
    urlValue.setBounds (urlRow);

    qrOverlay.setBounds (getLocalBounds());
}

void EarshotAudioProcessorEditor::timerCallback()
{
    meter.setLevels (processorRef.getPeakL(), processorRef.getPeakR());
    updateRecButton();

    // While the sign-in flow is mid-poll, keep the QR overlay showing
    // the device-link URL. The poller fires onLinked when paired, which
    // hides the overlay.
    if (signInFlow.isThreadRunning() && processorRef.getAuthToken().isEmpty())
    {
        auto url = signInFlow.getRedeemUrl();
        if (url.isNotEmpty() && ! qrOverlay.isVisible())
            showQrFor (url);
    }

    // Keep the "open on phone" button label in sync with auth state.
    openPhoneButton.setButtonText (
        processorRef.getAuthToken().isEmpty() ? "sign in" : "open on phone");

    if (processorRef.isRecording())
    {
        statusLabel.setText (juce::String::fromUTF8 ("recording · ")
                             + juce::String (processorRef.getFramesCapturedThisTake()) + " frames",
                             juce::dontSendNotification);
        statusLabel.setColour (juce::Label::textColourId, accent);
    }
    else if (processorRef.isWaitingForPlay())
    {
        statusLabel.setText (juce::String::fromUTF8 ("armed · waiting for play"),
                             juce::dontSendNotification);
        statusLabel.setColour (juce::Label::textColourId, accent);
    }
    else
    {
        statusLabel.setText ("idle", juce::dontSendNotification);
        statusLabel.setColour (juce::Label::textColourId, textMuted);
    }
}

void EarshotAudioProcessorEditor::updateRecButton()
{
    if (processorRef.isRecording())
    {
        recButton.setButtonText (juce::String::fromUTF8 ("■  stop"));
        recButton.setToggleState (true, juce::dontSendNotification);
    }
    else if (processorRef.isArmed())
    {
        recButton.setButtonText (juce::String::fromUTF8 ("◌  armed — cancel"));
        recButton.setToggleState (true, juce::dontSendNotification);
    }
    else
    {
        recButton.setButtonText (juce::String::fromUTF8 ("●  record next take"));
        recButton.setToggleState (false, juce::dontSendNotification);
    }
}

void EarshotAudioProcessorEditor::refreshTakes()
{
    takesList.setTakes (processorRef.getTakesPoller().getTakes());
}

void EarshotAudioProcessorEditor::refreshPublicUrl()
{
    auto url = processorRef.getHealthPoller().getPublicUrl();
    if (url.isEmpty())
    {
        urlValue.setText (juce::String::fromUTF8 ("connecting…"), juce::dontSendNotification);
        urlValue.setColour (juce::Label::textColourId, textMuted);
        copyButton.setEnabled (false);
        openPhoneButton.setEnabled (false);
    }
    else
    {
        auto display = url.startsWith ("https://") ? url.substring (8)
                     : url.startsWith ("http://")  ? url.substring (7)
                     : url;
        urlValue.setText (display, juce::dontSendNotification);
        urlValue.setColour (juce::Label::textColourId, accent);
        copyButton.setEnabled (true);
        openPhoneButton.setEnabled (true);
    }
}

void EarshotAudioProcessorEditor::refreshUploadStatus()
{
    auto& u = processorRef.getUploader();
    const int queued = u.getQueueDepth();

    juce::String suffix;
    juce::Colour col = textMuted;

    switch (u.getState())
    {
        case Uploader::State::Idle:
            suffix = queued > 0
                ? juce::String::fromUTF8 (" · queued ") + juce::String (queued)
                : juce::String::fromUTF8 (" · synced");
            break;
        case Uploader::State::Uploading:
            suffix = juce::String::fromUTF8 ("  uploading…");
            if (queued > 1) suffix << " (" << queued << ")";
            col = accent;
            break;
        case Uploader::State::Failed:
            suffix = juce::String::fromUTF8 (" · upload failed — retrying");
            col = juce::Colour (0xffff5a3c);
            break;
    }

    takesHeader.setText (juce::String ("recent takes") + suffix, juce::dontSendNotification);
    takesHeader.setColour (juce::Label::textColourId, col);
}

void EarshotAudioProcessorEditor::showQrFor (const juce::String& url)
{
    qrOverlay.setUrl (url);
    qrOverlay.setBounds (getLocalBounds());
    qrOverlay.setVisible (true);
    qrOverlay.toFront (false);
}
