cmake_minimum_required(VERSION 3.22)

project(Earshot VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "10.13" CACHE STRING "macOS deployment target")

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../third_party/JUCE
                 ${CMAKE_BINARY_DIR}/JUCE)

juce_add_plugin(Earshot
    COMPANY_NAME              "Earshot"
    BUNDLE_ID                 "fm.earshot.plugin"
    PLUGIN_MANUFACTURER_CODE  Eshf
    PLUGIN_CODE               Ersh
    FORMATS                   VST3 AU
    PRODUCT_NAME              "Earshot"
    IS_SYNTH                  FALSE
    NEEDS_MIDI_INPUT          FALSE
    NEEDS_MIDI_OUTPUT         FALSE
    COPY_PLUGIN_AFTER_BUILD   TRUE
)

juce_generate_juce_header(Earshot)

target_sources(Earshot PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginProcessor.h
    Source/PluginEditor.cpp
    Source/PluginEditor.h
    Source/BrandLookAndFeel.cpp
    Source/BrandLookAndFeel.h
    Source/CaptureBuffer.h
    Source/TakeWriter.cpp
    Source/TakeWriter.h
    Source/Uploader.cpp
    Source/Uploader.h
)

target_compile_definitions(Earshot PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
)

target_link_libraries(Earshot PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_audio_formats
    juce::juce_gui_basics
    juce::juce_gui_extra
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)
