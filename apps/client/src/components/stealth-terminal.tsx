import { useEffect, useRef, useState } from "preact/hooks";

type Props = {
	onExit: () => void;
};

const LOG_ENTRIES = [
	{ time: "10:14:12.108Z", level: "INFO", src: "s2.cluster.supervisor", msg: "Worker cluster pool initialized (pool_size=16, worker_threads=32)." },
	{ time: "10:14:12.894Z", level: "INFO", src: "s2.stream.webrtc", msg: "WebRTC peer connection established. Ingesting RTP stream @ 1080p60." },
	{ time: "10:14:13.201Z", level: "DEBUG", src: "s2.buffer.allocator", msg: "Allocating 2048MB off-heap direct buffer for frame queue assembly..." },
	{ time: "10:14:15.650Z", level: "INFO", src: "s2.pipeline.h264", msg: "Hardware accelerated decoder engaged: NVDEC/VAAPI profile High@4.2." },
	{ time: "10:14:18.432Z", level: "WARN", src: "s2.transport.congestion", msg: "Network jitter spike detected: RTT 182ms (window_size=512KB)." },
	{ time: "10:14:20.119Z", level: "WARN", src: "s2.memory.guard", msg: "Off-heap RSS allocation threshold exceeded: 30,482MB / 32,768MB (93.0%)." },
	{ time: "10:14:21.004Z", level: "WARN", src: "s2.memory.guard", msg: "Triggering concurrent minor GC cycle... [Allocation rate: 840MB/s]" },
	{ time: "10:14:22.312Z", level: "ERROR", src: "s2.pipeline.h264_decoder", msg: "Pipeline frame buffer saturated in worker thread #7 (queued_frames=420)." },
	{ time: "10:14:22.955Z", level: "FATAL", src: "s2.core.runtime", msg: "Uncaught OutOfMemoryError in native thread allocator pool." },
	{ time: "10:14:22.956Z", level: "TRACE", src: "s2.core.runtime", msg: "java.lang.OutOfMemoryError: Direct buffer memory" },
	{ time: "10:14:22.957Z", level: "TRACE", src: "s2.core.runtime", msg: "    at java.base/java.nio.Bits.reserveMemory(Bits.java:178)" },
	{ time: "10:14:22.958Z", level: "TRACE", src: "s2.core.runtime", msg: "    at java.base/java.nio.DirectByteBuffer.<init>(DirectByteBuffer.java:123)" },
	{ time: "10:14:22.959Z", level: "TRACE", src: "s2.core.runtime", msg: "    at java.base/java.nio.ByteBuffer.allocateDirect(ByteBuffer.java:332)" },
	{ time: "10:14:22.960Z", level: "TRACE", src: "s2.core.runtime", msg: "    at io.netty.buffer.PoolArena$DirectArena.allocateHuge(PoolArena.java:708)" },
	{ time: "10:14:22.961Z", level: "TRACE", src: "s2.core.runtime", msg: "    at io.netty.buffer.PooledByteBufAllocator.newDirectBuffer(PooledByteBufAllocator.java:394)" },
	{ time: "10:14:22.962Z", level: "TRACE", src: "s2.core.runtime", msg: "    at com.s2pipe.engine.codec.NALDecoder.processFrame(NALDecoder.java:412)" },
	{ time: "10:14:22.963Z", level: "TRACE", src: "s2.core.runtime", msg: "    at com.s2pipe.engine.pipeline.StreamWorker.run(StreamWorker.java:189)" },
	{ time: "10:14:22.964Z", level: "TRACE", src: "s2.core.runtime", msg: "    at java.base/java.lang.Thread.run(Thread.java:1583)" },
	{ time: "10:14:23.102Z", level: "CRIT", src: "kernel", msg: "Out of Memory: Kill process 28419 (s2_engine_worker) score 948 or sacrifice child" },
	{ time: "10:14:23.103Z", level: "CRIT", src: "kernel", msg: "Killed process 28419 (s2_engine_worker) total-vm:34829104kB, anon-rss:31498112kB, file-rss:128kB" },
	{ time: "10:14:23.441Z", level: "ERROR", src: "systemd[1]", msg: "s2-engine-worker.service: Main process exited, code=killed, status=9/KILL" },
	{ time: "10:14:23.442Z", level: "ERROR", src: "systemd[1]", msg: "s2-engine-worker.service: Unit entered failed state with result 'oom-kill'." },
	{ time: "10:14:24.015Z", level: "INFO", src: "s2.watchdog", msg: "Auto-recovery daemon engaged. Dumping core trace to /var/log/engine/crash-20261004.dump..." },
	{ time: "10:14:24.890Z", level: "DEBUG", src: "s2.watchdog", msg: "Core memory dump written: 4.8 GB in 659ms (hash=e3b0c44298fc1c149afbf4c8996fb924)." },
	{ time: "10:14:25.109Z", level: "WARN", src: "s2.watchdog", msg: "Service automatic restart held: manual administrator diagnosis required." },
];

export default function StealthTerminal({ onExit }: Props) {
	const logContainerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [command, setCommand] = useState("");
	const [history, setHistory] = useState<string[]>([]);

	useEffect(() => {
		if (logContainerRef.current) {
			logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
		}
		inputRef.current?.focus();
	}, [history]);

	function handleKeyDown(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === "Enter") {
			const trimmed = command.trim();
			if (!trimmed) return;
			if (trimmed === "clear") {
				setHistory([]);
			} else {
				setHistory((prev: string[]) => [
					...prev,
					`root@srv-prod-worker02:/var/log/engine# ${trimmed}`,
					`bash: ${trimmed}: command failed (process lock held by diagnostic daemon)`,
				]);
			}
			setCommand("");
		}
	}

	return (
		<div
			class="stealth-terminal-overlay"
			role="dialog"
			aria-label="System Diagnostics Console"
			onClick={() => inputRef.current?.focus()}
		>
			{/* Terminal Window Header */}
			<div class="stealth-titlebar">
				<div class="stealth-titlebar-left">
					<div class="stealth-traffic-lights">
						<span class="stealth-dot close" />
						<span class="stealth-dot minimize" />
						<span class="stealth-dot maximize" />
					</div>
					<span class="stealth-window-title">
						root@srv-prod-worker02: /var/log/engine/crash.log (PID: 28419) — bash — 164x46
					</span>
				</div>

				<div class="stealth-titlebar-right">
					<span class="stealth-badge-critical">
						<span class="stealth-badge-pulse" />
						CRITICAL OOM
					</span>
					<div class="stealth-search-box">
						<span class="stealth-search-icon">🔍</span>
						<input
							type="text"
							class="stealth-search-input"
							placeholder="grep -E 'FATAL|OOM'..."
							tabIndex={-1}
							onClick={(e) => e.stopPropagation()}
						/>
					</div>
					{/* Disguised Exit Button */}
					<button
						type="button"
						class="stealth-exit-btn"
						title="Export raw diagnostic stack trace to local file"
						onClick={(e) => {
							e.stopPropagation();
							onExit();
						}}
					>
						<span class="stealth-exit-icon">⬇</span> Export Raw Trace
					</button>
				</div>
			</div>

			{/* Sub-header System Metric Strip */}
			<div class="stealth-metric-strip">
				<span class="stealth-metric-item">
					<strong>CLUSTER:</strong> s2-pipe-prod-br1
				</span>
				<span class="stealth-metric-sep">|</span>
				<span class="stealth-metric-item">
					<strong>KERNEL:</strong> 6.8.0-45-generic #45-Ubuntu SMP
				</span>
				<span class="stealth-metric-sep">|</span>
				<span class="stealth-metric-item">
					<strong>MEMORY:</strong> <span class="stealth-highlight-red">31.8GB / 32.0GB (99.4%)</span>
				</span>
				<span class="stealth-metric-sep">|</span>
				<span class="stealth-metric-item">
					<strong>STATUS:</strong> <span class="stealth-highlight-red">Exited (137) OOMKilled</span>
				</span>
			</div>

			{/* Terminal Logs Viewport */}
			<div class="stealth-logs-viewport" ref={logContainerRef}>
				{LOG_ENTRIES.map((entry, idx) => (
					<div key={idx} class={`stealth-log-row log-${entry.level.toLowerCase()}`}>
						<span class="stealth-log-time">{entry.time}</span>
						<span class={`stealth-log-level lvl-${entry.level.toLowerCase()}`}>[{entry.level}]</span>
						<span class="stealth-log-src">[{entry.src}]</span>
						<span class="stealth-log-msg">{entry.msg}</span>
					</div>
				))}

				{history.map((hist, idx) => (
					<div key={`h-${idx}`} class="stealth-log-row log-interactive">
						<span class="stealth-log-interactive-text">{hist}</span>
					</div>
				))}

				{/* Active Shell Prompt Line */}
				<div class="stealth-prompt-line">
					<span class="stealth-prompt-user">root@srv-prod-worker02</span>
					<span class="stealth-prompt-colon">:</span>
					<span class="stealth-prompt-path">/var/log/engine</span>
					<span class="stealth-prompt-symbol">#</span>
					<input
						ref={inputRef}
						type="text"
						class="stealth-cli-input"
						value={command}
						onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
						onKeyDown={handleKeyDown}
						spellcheck={false}
						autoComplete="off"
					/>
				</div>
			</div>

			{/* Terminal Status Bar (Footer) */}
			<div class="stealth-statusbar">
				<div class="stealth-status-left">
					<span>UTF-8</span>
					<span class="stealth-status-sep">|</span>
					<span>Tab: 4</span>
					<span class="stealth-status-sep">|</span>
					<span>Lines: {LOG_ENTRIES.length + history.length}</span>
					<span class="stealth-status-sep">|</span>
					<span>Read-Only Buffer (Interactive Subshell)</span>
				</div>
				<div class="stealth-status-right">
					<span>DIAG_PORT: 9229</span>
					<span class="stealth-status-sep">|</span>
					<span>THREAD: pool-worker-7</span>
				</div>
			</div>
		</div>
	);
}
