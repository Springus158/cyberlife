import Foundation
import Speech
import AVFoundation

func emit(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}

class VoiceRecognizer: NSObject {
    private let audioEngine = AVAudioEngine()
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var running = true
    private var tapInstalled = false

    init(locale: String) {
        super.init()
        speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
    }

    func output(_ dict: [String: Any]) { emit(dict) }

    func start() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self = self else { return }
            switch status {
            case .authorized:
                DispatchQueue.main.async {
                    self.bootAudioEngineAndStartTask()
                }
            case .denied:
                self.output(["type": "error", "message": "Speech recognition denied. Enable in System Settings → Privacy → Speech Recognition."])
                exit(1)
            case .restricted:
                self.output(["type": "error", "message": "Speech recognition restricted on this device."])
                exit(1)
            case .notDetermined:
                self.output(["type": "error", "message": "Speech recognition not determined."])
                exit(1)
            @unknown default:
                self.output(["type": "error", "message": "Unknown speech recognition status."])
                exit(1)
            }
        }
    }

    func bootAudioEngineAndStartTask() {
        guard let speechRecognizer = speechRecognizer, speechRecognizer.isAvailable else {
            output(["type": "error", "message": "Speech recognizer not available for this language."])
            exit(1)
        }

        if !tapInstalled {
            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.recognitionRequest?.append(buffer)
            }
            tapInstalled = true

            audioEngine.prepare()
            do {
                try audioEngine.start()
            } catch {
                output(["type": "error", "message": "Audio engine failed: \(error.localizedDescription)"])
                exit(1)
            }
        }

        startNewRecognitionTask()
        output(["type": "started"])
    }

    func startNewRecognitionTask() {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }

            if let result = result {
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                self.output(["type": isFinal ? "final" : "partial", "text": text])

                if isFinal {
                    DispatchQueue.main.async { self.softReset() }
                }
            }

            if let error = error as NSError? {
                if error.code == 216 || error.code == 1110 {
                    DispatchQueue.main.async { self.softReset() }
                } else {
                    self.output(["type": "error", "message": error.localizedDescription])
                    DispatchQueue.main.async { self.softReset() }
                }
            }
        }
    }

    func softReset() {
        guard running else { return }
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        startNewRecognitionTask()
        output(["type": "started"])
    }

    func stop() {
        running = false
        audioEngine.stop()
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        output(["type": "stopped"])
        exit(0)
    }
}

// Emits the same {type,text} JSON shape as VoiceRecognizer so the frontend handles both engines identically.
class ScribeRecognizer: NSObject, URLSessionWebSocketDelegate {
    private let audioEngine = AVAudioEngine()
    private let apiKey: String
    private let languageCode: String
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var converter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private var running = true
    private var tapInstalled = false

    init(apiKey: String, languageCode: String) {
        self.apiKey = apiKey
        self.languageCode = languageCode
        super.init()
    }

    func start() {
        var components = URLComponents(string: "wss://api.elevenlabs.io/v1/speech-to-text/realtime")!
        components.queryItems = [
            URLQueryItem(name: "model_id", value: "scribe_v2_realtime"),
            URLQueryItem(name: "audio_format", value: "pcm_16000"),
            URLQueryItem(name: "commit_strategy", value: "vad"),
        ]
        if !languageCode.isEmpty {
            components.queryItems?.append(URLQueryItem(name: "language_code", value: languageCode))
        }

        var request = URLRequest(url: components.url!)
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")

        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: request)
        task?.resume()
        receiveLoop()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        startAudioEngine()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard running else { return }
        var detail = ""
        if let reason = reason, let str = String(data: reason, encoding: .utf8) { detail = str }
        emit(["type": "error", "message": "Scribe connection closed (\(closeCode.rawValue)) \(detail)"])
        DispatchQueue.main.async { self.stop() }
    }

    private func startAudioEngine() {
        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        converter = AVAudioConverter(from: inputFormat, to: targetFormat)

        inputNode.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            self?.streamBuffer(buffer)
        }
        tapInstalled = true

        audioEngine.prepare()
        do {
            try audioEngine.start()
            emit(["type": "started"])
        } catch {
            emit(["type": "error", "message": "Audio engine failed: \(error.localizedDescription)"])
            DispatchQueue.main.async { self.stop() }
        }
    }

    private func streamBuffer(_ buffer: AVAudioPCMBuffer) {
        guard running, let converter = converter else { return }

        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var consumed = false
        let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        var convertError: NSError?
        converter.convert(to: outBuffer, error: &convertError, withInputFrom: inputBlock)
        if convertError != nil || outBuffer.frameLength == 0 { return }

        guard let channelData = outBuffer.int16ChannelData else { return }
        let byteCount = Int(outBuffer.frameLength) * 2
        let data = Data(bytes: channelData[0], count: byteCount)
        let base64 = data.base64EncodedString()

        let message: [String: Any] = [
            "message_type": "input_audio_chunk",
            "audio_base_64": base64,
            "commit": false,
            "sample_rate": 16000,
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: message),
              let str = String(data: json, encoding: .utf8) else { return }

        task?.send(.string(str)) { error in
            if let error = error {
                emit(["type": "error", "message": "Send failed: \(error.localizedDescription)"])
            }
        }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self = self, self.running else { return }
            switch result {
            case .failure(let error):
                emit(["type": "error", "message": error.localizedDescription])
                DispatchQueue.main.async { self.stop() }
            case .success(let message):
                if case let .string(text) = message {
                    self.handleMessage(text)
                }
                self.receiveLoop()
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["message_type"] as? String else { return }

        switch type {
        case "session_started":
            break
        case "partial_transcript":
            if let t = obj["text"] as? String { emit(["type": "partial", "text": t]) }
        case "committed_transcript", "committed_transcript_with_timestamps":
            if let t = obj["text"] as? String, !t.isEmpty { emit(["type": "final", "text": t]) }
        default:
            if let err = obj["error"] as? String {
                emit(["type": "error", "message": err])
            }
        }
    }

    func softReset() {
        // VAD commit strategy segments speech automatically; nothing to reset.
    }

    func stop() {
        running = false
        audioEngine.stop()
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        task?.cancel(with: .normalClosure, reason: nil)
        emit(["type": "stopped"])
        exit(0)
    }
}

protocol Recognizer: AnyObject {
    func start()
    func softReset()
    func stop()
}
extension VoiceRecognizer: Recognizer {}
extension ScribeRecognizer: Recognizer {}

var lang = "en-US"
var engine = "native"
var apiKey = ""

for arg in CommandLine.arguments.dropFirst() {
    if arg.hasPrefix("--engine=") {
        engine = String(arg.dropFirst("--engine=".count))
    } else if arg.hasPrefix("--key=") {
        apiKey = String(arg.dropFirst("--key=".count))
    } else if !arg.hasPrefix("--") {
        lang = arg
    }
}

let recognizer: Recognizer
if engine == "scribe" {
    let languageCode = String(lang.prefix(while: { $0 != "-" }))
    recognizer = ScribeRecognizer(apiKey: apiKey, languageCode: languageCode)
} else {
    recognizer = VoiceRecognizer(locale: lang)
}

DispatchQueue.global().async {
    while let line = readLine() {
        let cmd = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if cmd == "stop" {
            DispatchQueue.main.async { recognizer.stop() }
        } else if cmd == "reset" {
            DispatchQueue.main.async { recognizer.softReset() }
        }
    }
    DispatchQueue.main.async { recognizer.stop() }
}

recognizer.start()
RunLoop.main.run()
