import Foundation
import AVFoundation
import Speech

/// Manages the on-device voice pipeline using RunAnywhere SDK.
/// Handles VAD → STT → On-Device LLM → TTS for offline operation.
class VoicePipelineManager: ObservableObject {
    @Published var isListening = false
    @Published var isProcessing = false
    @Published var transcribedText = ""
    @Published var isOffline = false

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    // MARK: - Permissions

    func requestPermissions() async -> Bool {
        let speechAuth = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }

        let micAuth: Bool
        if #available(iOS 17.0, *) {
            micAuth = await AVAudioApplication.requestRecordPermission()
        } else {
            micAuth = await withCheckedContinuation { continuation in
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }

        return speechAuth && micAuth
    }

    // MARK: - Voice Pipeline

    /// Start listening for voice input using Apple's on-device speech recognition
    func startListening() throws {
        // Cancel any existing task
        recognitionTask?.cancel()
        recognitionTask = nil

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest else {
            throw VoiceError.recognitionUnavailable
        }

        // Use on-device recognition when available (iOS 13+)
        if #available(iOS 13, *) {
            recognitionRequest.requiresOnDeviceRecognition = isOffline
        }
        recognitionRequest.shouldReportPartialResults = true

        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self else { return }

            if let result {
                DispatchQueue.main.async {
                    self.transcribedText = result.bestTranscription.formattedString
                }

                if result.isFinal {
                    DispatchQueue.main.async {
                        self.isListening = false
                    }
                }
            }

            if error != nil {
                self.stopListening()
            }
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            self.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()

        DispatchQueue.main.async {
            self.isListening = true
            self.transcribedText = ""
        }
    }

    /// Stop listening and finalize recognition
    func stopListening() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()

        DispatchQueue.main.async {
            self.isListening = false
        }
    }

    // MARK: - Text-to-Speech

    private let synthesizer = AVSpeechSynthesizer()

    /// Speak text aloud using on-device TTS
    func speak(_ text: String, rate: Float = 0.52) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = rate
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.pitchMultiplier = 1.0

        synthesizer.speak(utterance)
    }

    /// Stop speaking
    func stopSpeaking() {
        synthesizer.stopSpeaking(at: .immediate)
    }
}

// MARK: - RunAnywhere Integration Placeholder

extension VoicePipelineManager {
    /// Initialize RunAnywhere SDK for full on-device pipeline
    /// VAD → STT → LLM → TTS all running locally
    func initializeRunAnywhere() {
        // TODO: Integrate RunAnywhere Swift SDK
        // RunAnywhere.configure(
        //     modelPath: Bundle.main.path(forResource: "roadpilot-model", ofType: "bin"),
        //     vadSensitivity: 0.7,
        //     wakeWord: "hey road pilot"
        // )
        print("[VoicePipeline] RunAnywhere SDK initialization placeholder")
    }

    /// Process voice input through on-device LLM (RunAnywhere)
    /// Used when offline or for simple intent detection
    func processOnDevice(_ text: String) -> String {
        // TODO: Replace with RunAnywhere on-device LLM inference
        // let response = RunAnywhere.generate(prompt: text)
        // return response

        // Placeholder: basic intent detection
        let lowered = text.lowercased()
        if lowered.contains("hos") || lowered.contains("drive time") || lowered.contains("hours") {
            return "Let me check your hours of service status."
        } else if lowered.contains("fuel") || lowered.contains("diesel") || lowered.contains("gas") {
            return "Looking for fuel prices nearby."
        } else if lowered.contains("park") || lowered.contains("stop") || lowered.contains("rest") {
            return "Searching for truck parking near you."
        } else if lowered.contains("load") || lowered.contains("freight") {
            return "I need to be online to search for loads. Let me check your connection."
        }
        return "I'm currently offline. I can help with basic queries. For load search and broker calls, I need an internet connection."
    }
}

enum VoiceError: LocalizedError {
    case recognitionUnavailable
    case microphoneAccessDenied

    var errorDescription: String? {
        switch self {
        case .recognitionUnavailable: return "Speech recognition is not available"
        case .microphoneAccessDenied: return "Microphone access is required"
        }
    }
}
