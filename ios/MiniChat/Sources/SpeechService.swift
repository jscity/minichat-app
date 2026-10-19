import AVFoundation
import Foundation
import Observation
import Speech

/// iOS 26 SpeechAnalyzer 本机中文识别。优先 SpeechTranscriber，本机不支持中文时退到 DictationTranscriber。
/// 每得到一段最终结果就回调 `onFinal`；`partial` 是正在识别的临时文字，只用于显示。
///
/// 为了按下就能说：`warmUp()` 在启动时预先选好语言、下载模型、取得音频格式并把模型常驻内存；
/// `start()` 先开麦克风把声音缓存在流里，再挂上识别器，按下那一刻起说的话都不会丢。
@MainActor
@Observable
final class SpeechService {
    enum Phase { case idle, starting, listening, stopping }

    private(set) var phase: Phase = .idle
    private(set) var partial = ""
    private(set) var message: String?
    /// 最近一次听到内容的时间，连续输入模式用它判断是否长时间没说话。
    private(set) var lastActivity = Date.now
    var onFinal: ((String) -> Void)?

    var isActive: Bool { phase != .idle }

    private struct Setup {
        let locale: Locale
        let useSpeechTranscriber: Bool
        let format: AVAudioFormat
    }

    /// 各个 SpeechService 实例共用。
    private static var setup: Setup?
    private static var warming: Task<Setup, Error>?

    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    /// 还在启动时就收到的结束请求，启动完成后执行。
    private enum PendingEnd { case none, stop, cancel }
    private var pendingEnd = PendingEnd.none
    /// cancel 后丢弃还在路上的识别结果。
    private var discarding = false

    private struct Failure: Error { let text: String }
    private static let options = SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .processLifetime)

    /// 启动时调用一次即可；失败了下次按下时再试。
    func warmUp() async {
        _ = try? await Self.prepare()
    }

    private static func prepare() async throws -> Setup {
        if let setup { return setup }
        if let warming { return try await warming.value }
        let task = Task { @MainActor () throws -> Setup in
            let chinese = Locale(identifier: "zh-CN")
            let module: any SpeechModule
            let locale: Locale
            let useSpeech: Bool
            if SpeechTranscriber.isAvailable, let found = await SpeechTranscriber.supportedLocale(equivalentTo: chinese) {
                module = SpeechTranscriber(locale: found, preset: .progressiveTranscription)
                (locale, useSpeech) = (found, true)
            } else if let found = await DictationTranscriber.supportedLocale(equivalentTo: chinese) {
                module = DictationTranscriber(locale: found, preset: .progressiveShortDictation)
                (locale, useSpeech) = (found, false)
            } else {
                throw Failure(text: "本机不支持中文语音识别")
            }
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                try await request.downloadAndInstall()
            }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
                throw Failure(text: "语音模型不可用")
            }
            // 预加载模型并常驻，之后每次按下不用再等加载。
            let analyzer = SpeechAnalyzer(modules: [module], options: options)
            try? await analyzer.prepareToAnalyze(in: format)
            await analyzer.cancelAndFinishNow()
            return Setup(locale: locale, useSpeechTranscriber: useSpeech, format: format)
        }
        warming = task
        do {
            let result = try await task.value
            setup = result
            warming = nil
            return result
        } catch {
            warming = nil
            throw error
        }
    }

    /// `hints`：当前待取的取件码、位置名，作为识别的上下文提示。
    func start(hints: [String]) async {
        guard phase == .idle else { return }
        phase = .starting
        pendingEnd = .none
        discarding = false
        message = nil
        lastActivity = .now
        do {
            if AVAudioApplication.shared.recordPermission != .granted {
                guard await AVAudioApplication.requestRecordPermission() else { throw Failure(text: "没有麦克风权限，请到系统设置里打开") }
            }
            if Self.setup == nil { partial = "准备中文语音模型…" }
            let setup = try await Self.prepare()
            partial = ""

            // 1. 先开麦克风，声音缓存在流里。
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            self.continuation = continuation
            let input = engine.inputNode
            let inputFormat = input.outputFormat(forBus: 0)
            guard let converter = AVAudioConverter(from: inputFormat, to: setup.format) else { throw Failure(text: "麦克风格式不支持") }
            Self.installTap(on: input, format: inputFormat, converter: converter, target: setup.format, continuation: continuation)
            engine.prepare()
            try engine.start()

            // 2. 再挂上识别器，从流的开头开始处理（这个初始化会直接开始分析，不用再等）。
            let module = makeModule(setup)
            let context = AnalysisContext()
            if !hints.isEmpty { context.contextualStrings[.general] = hints }
            analyzer = SpeechAnalyzer(inputSequence: stream, modules: [module], options: Self.options, analysisContext: context)
            phase = .listening
            switch pendingEnd {
            case .stop: await stop()
            case .cancel: await cancel()
            case .none: break
            }
        } catch {
            message = (error as? Failure)?.text ?? "语音识别启动失败：\(error.localizedDescription)"
            await teardown()
        }
    }

    /// 结束并交出最后的识别结果。各步都有超时，保证一定回到 idle，按钮不会卡在“正在听”。
    func stop() async {
        switch phase {
        case .starting:
            pendingEnd = .stop
        case .listening:
            phase = .stopping
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            continuation?.finish()
            if let analyzer {
                await Self.waitAtMost(2) { try? await analyzer.finalizeAndFinishThroughEndOfInput() }
            }
            if let resultsTask {
                await Self.waitAtMost(1) { await resultsTask.value }
            }
            await teardown()
        case .idle, .stopping:
            break
        }
    }

    /// 结束并丢弃结果（单击误触时用）。
    func cancel() async {
        switch phase {
        case .starting:
            pendingEnd = .cancel
        case .listening, .stopping:
            discarding = true
            await teardown()
        case .idle:
            break
        }
    }

    /// 等 work 完成，最多等 seconds 秒；超时就不再等（work 留在后台自行结束）。
    private static func waitAtMost(_ seconds: Double, _ work: @escaping () async -> Void) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            let once = Once()
            Task { @MainActor in
                await work()
                once.run { done.resume() }
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(seconds))
                once.run { done.resume() }
            }
        }
    }

    @MainActor private final class Once {
        private var fired = false
        func run(_ body: () -> Void) {
            guard !fired else { return }
            fired = true
            body()
        }
    }

    private func teardown() async {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        continuation?.finish()
        continuation = nil
        if let analyzer {
            await Self.waitAtMost(1) { await analyzer.cancelAndFinishNow() }
        }
        analyzer = nil
        resultsTask?.cancel()
        resultsTask = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        partial = ""
        phase = .idle
    }

    private func makeModule(_ setup: Setup) -> any SpeechModule {
        if setup.useSpeechTranscriber {
            let transcriber = SpeechTranscriber(locale: setup.locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
            resultsTask = Task { [weak self] in
                do {
                    for try await result in transcriber.results {
                        self?.handle(String(result.text.characters), final: result.isFinal)
                    }
                } catch {}
            }
            return transcriber
        }
        let transcriber = DictationTranscriber(locale: setup.locale, preset: .progressiveShortDictation)
        resultsTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    self?.handle(String(result.text.characters), final: result.isFinal)
                }
            } catch {}
        }
        return transcriber
    }

    private func handle(_ text: String, final: Bool) {
        guard !discarding else { return }
        lastActivity = .now
        if final {
            partial = ""
            if !text.trimmingCharacters(in: .whitespaces).isEmpty { onFinal?(text) }
        } else {
            partial = text
        }
    }

    /// 放在 nonisolated 里：音频回调在音频线程执行，不能继承 MainActor。
    nonisolated private static func installTap(on node: AVAudioInputNode, format: AVAudioFormat, converter: AVAudioConverter,
                                               target: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation) {
        node.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            let ratio = target.sampleRate / buffer.format.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var consumed = false
            var error: NSError?
            converter.convert(to: output, error: &error) { _, status in
                if consumed {
                    status.pointee = .noDataNow
                    return nil
                }
                consumed = true
                status.pointee = .haveData
                return buffer
            }
            if error == nil, output.frameLength > 0 {
                continuation.yield(AnalyzerInput(buffer: output))
            }
        }
    }
}
