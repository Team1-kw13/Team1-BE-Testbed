<script>
	// App.svelte — PCM16 @ 24kHz end-to-end (binary over WS)
	// - Mic → AudioWorklet → PCM16 24kHz → WS (commit/raw/end)
	// - Server → Client 오디오도 PCM16 24kHz 원시 바이너리 → 주기적 WAV 래핑 재생
	// - output_index → displayIdx 매핑: 한 블록에 델타 누적

	let ws = null;
	let wsUrl = 'ws://localhost:3000/voice';
	let connected = false;

	// UI
	let preprompts = ['top3', '복지', '의료'];
	let inputText = '';
	let isRecording = false;
	// Audio device list & selection
	let audioInputs = []; // [{deviceId, label}]
	let selectedDeviceId = ''; // chosen input device

	// Messages timeline (old → new)
	// { id, role:'user'|'assistant', idx?:number, text?:string, transcript?:string, audioUrl?:string }
	let messages = [];

	// Streams by UI displayIdx
	// NOTE: 서버→클라 오디오는 PCM16 청크(Int16Array)를 모아 WAV로 래핑해 재생
	const streams = new Map(); // displayIdx -> { text, transcript, pcmChunks:Int16Array[], audioUrl:null, done:{text,audio,transcript}, stitchTimer:null }
	let lastOutputIndex = 0; // last displayIdx

	// Map server output_index → UI displayIdx (server may reuse 0)
	const serverToDisplay = new Map(); // serverIdx -> displayIdx
	let displaySeq = 0;
	// preprompt 응답을 꽂아 넣을 자리(사용자가 누른 직후에 placeholder 생성)
	let pendingPrepromptIdx = null;

	function isComplete(s) {
		if (!s) return true;
		const noAudio = s.pcmChunks.length === 0 && !s.audioUrl;
		return s.done.text && s.done.transcript && (s.done.audio || noAudio);
	}
	function getDisplayIdx(serverIdx) {
		if (serverToDisplay.has(serverIdx)) {
			const disp = serverToDisplay.get(serverIdx);
			const st = streams.get(disp);
			if (isComplete(st)) {
				const next = displaySeq++;
				serverToDisplay.set(serverIdx, next);
				ensureStream(next);
				return next;
			}
			return disp;
		} else {
			const next = displaySeq++;
			serverToDisplay.set(serverIdx, next);
			ensureStream(next);
			return next;
		}
	}

	// Panels
	let summaryImage = null;
	let suggestions = [];
	let officeInfo = null;
	let errorLog = [];
	let eventLog = [];

	// ===== Utilities =====
	const uid = () => Math.random().toString(36).slice(2);
	const now = () => new Date().toLocaleTimeString();
	const MAX_LOG = 400;
	const MAX_MESSAGES = 200;
	function log(s) {
		eventLog = [`[${now()}] ${s}`, ...eventLog].slice(0, MAX_LOG);
	}
	function logErr(s) {
		errorLog = [`[${now()}] ${s}`, ...errorLog].slice(0, MAX_LOG);
	}

	function ensureStream(idx) {
		if (!streams.has(idx)) {
			streams.set(idx, {
				text: '',
				transcript: '',
				pcmChunks: [],
				audioUrl: null,
				done: { text: false, audio: false, transcript: false },
				stitchTimer: null
			});
			// Add assistant block that keeps updating
			messages = [
				...messages,
				{ id: uid(), role: 'assistant', idx, text: '', transcript: '', audioUrl: null }
			];
		}
		return streams.get(idx);
	}
	function findAssistantMsgByIdx(idx) {
		return messages.find((m) => m.role === 'assistant' && m.idx === idx);
	}
	function syncAssistantView(idx) {
		const s = streams.get(idx);
		const m = findAssistantMsgByIdx(idx);
		if (m && s) {
			m.text = s.text;
			m.transcript = s.transcript;
			m.audioUrl = s.audioUrl;
			messages = [...messages];
		}
	}
	function revokeAudioUrls() {
		for (const [, s] of streams) {
			if (s.audioUrl) URL.revokeObjectURL(s.audioUrl);
			s.audioUrl = null;
		}
	}
	function pruneMessages() {
		const overflow = messages.length - MAX_MESSAGES;
		if (overflow <= 0) return;
		const removed = messages.slice(0, overflow);
		for (const m of removed) {
			if (m.role === 'assistant' && m.idx !== undefined) {
				const st = streams.get(m.idx);
				if (st) {
					if (st.audioUrl) URL.revokeObjectURL(st.audioUrl);
					streams.delete(m.idx);
				}
			}
		}
		messages = messages.slice(overflow);
	}
	$: messages.length > MAX_MESSAGES && pruneMessages();

	// --- Mic permission helper ---
	async function ensureMicPermission() {
		const s = await navigator.mediaDevices.getUserMedia({ audio: true });
		try {
			s.getTracks().forEach((t) => t.stop());
		} catch {}
		log('마이크 권한 허용됨');
	}

	// --- Device helpers ---
	async function getMicStream() {
		const byId = selectedDeviceId ? { audio: { deviceId: { exact: selectedDeviceId } } } : null;
		return await navigator.mediaDevices.getUserMedia(byId || { audio: true });
	}
	async function refreshAudioInputs() {
		const list = await navigator.mediaDevices.enumerateDevices();
		const aud = list
			.filter((d) => d.kind === 'audioinput')
			.map((d) => ({ deviceId: d.deviceId, label: d.label || '마이크(라벨 권한 필요)' }));
		audioInputs = aud;
		if (!selectedDeviceId && aud.length) selectedDeviceId = aud[0].deviceId;
	}

	// ===== WebSocket =====
	function connect() {
		if (ws) ws.close();
		ws = new WebSocket(wsUrl);
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => {
			connected = true;
			log('WS 연결됨');
		};
		ws.onclose = () => {
			connected = false;
			ws = null;
			log('WS 연결 종료');
			stopRecording(true);
		};
		ws.onerror = (e) => logErr('WS 오류: ' + (e?.message || 'unknown'));
		ws.onmessage = (evt) => onMessage(evt);
	}
	function disconnect() {
		ws && ws.close();
	}
	function send(channel, type, payload = {}) {
		if (!connected) {
			logErr('연결되지 않음');
			return;
		}
		const msg = { channel, type, ...payload };
		ws.send(JSON.stringify(msg));
		log(`송신 → ${channel} / ${type}`);
	}

	// ===== Spec actions =====
	function sendPreprompt(name) {
		// 1) 사용자 로그 남기기
		messages = [...messages, { id: uid(), role: 'user', text: `프리프롬프트 선택: ${name}` }];
		// 2) 서버에 요청 전송
		send('openai:conversation', 'preprompted', { enum: name });
		// 3) 이 응답이 들어갈 어시스턴트 placeholder 블록을 미리 하나 예약
		const idx = displaySeq++;
		ensureStream(idx); // 빈 assistant 카드 생성
		pendingPrepromptIdx = idx;
		lastOutputIndex = idx;
		messages = [...messages, { id: uid(), role: 'user', text: `프리프롬프트 선택: ${name}` }];
	}
	function requestSummary() {
		send('sonju:summarize', null, {});
		messages = [...messages, { id: uid(), role: 'user', text: '요약 요청' }];
	}

	// ===== Recording via AudioWorklet (PCM16 @ 24kHz) =====
	let audioCtx = null,
		workletNode = null,
		srcNode = null,
		silentGain = null,
		mediaStream = null;
	let workletUrl = null;

	function createResamplerWorkletUrl() {
		const code = `
      class PCM16Resampler extends AudioWorkletProcessor {
        constructor(){
          super();
          this.target = 24000;
          this.inRate = sampleRate; // input device rate
          this.step = this.inRate / this.target; // input samples per one output sample
          this.t = 0; // fractional read index in input domain
          this.carry = new Float32Array(0);
        }
        process(inputs){
          const chs = inputs[0];
          if(!chs || chs.length===0) return true;
          const input = chs[0]; // mono (first channel)
          // concat carry + input
          const inBuf = new Float32Array(this.carry.length + input.length);
          inBuf.set(this.carry, 0);
          inBuf.set(input, this.carry.length);

          const maxOut = Math.floor((inBuf.length - 1 - this.t) / this.step);
          if(maxOut <= 0){
            this.carry = inBuf;
            return true;
          }
          const out = new Int16Array(maxOut);
          let t = this.t;
          for(let j=0;j<maxOut;j++){
            const i0 = Math.floor(t);
            const frac = t - i0;
            const s0 = inBuf[i0];
            const s1 = inBuf[i0+1];
            const s = s0 + (s1 - s0) * frac; // linear interp
            const v = Math.max(-1, Math.min(1, s));
            out[j] = v < 0 ? (v * 0x8000) : (v * 0x7FFF);
            t += this.step;
          }
          const consumed = Math.floor(t);
          this.t = t - consumed;
          this.carry = inBuf.subarray(consumed);
          this.port.postMessage(out.buffer, [out.buffer]);
          return true;
        }
      }
      registerProcessor('pcm16-24k-writer', PCM16Resampler);
    `;
		return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
	}

	async function startRecording() {
		if (!connected) {
			logErr('연결 후 사용하세요');
			return;
		}
		if (isRecording) return;

		// 0) 세션 시작 알림
		send('openai:conversation', 'input_audio_buffer.commit');

		// 1) 장치/스트림
		await refreshAudioInputs();
		mediaStream = await getMicStream();

		// 2) 오디오 컨텍스트 & 워클릿
		audioCtx = new (window.AudioContext || window.webkitAudioContext)();
		workletUrl = createResamplerWorkletUrl();
		await audioCtx.audioWorklet.addModule(workletUrl);

		srcNode = audioCtx.createMediaStreamSource(mediaStream);
		workletNode = new AudioWorkletNode(audioCtx, 'pcm16-24k-writer');
		silentGain = audioCtx.createGain();
		silentGain.gain.value = 0; // local mute

		srcNode.connect(workletNode);
		workletNode.connect(silentGain);
		silentGain.connect(audioCtx.destination);

		// 3) PCM16 24kHz 청크를 수신해서 바이너리로 전송
		workletNode.port.onmessage = (ev) => {
			const buf = ev.data; // ArrayBuffer (Int16 PCM)
			if (connected) {
				ws.send(buf);
			}
		};

		isRecording = true;
		messages = [...messages, { id: uid(), role: 'user', text: '🎙️ (음성 발화 중…)' }];
		log('녹음 시작 (PCM16 @ 24kHz)');
	}

	function stopRecording(skipEnd = false) {
		if (!isRecording) return;
		try {
			srcNode && srcNode.disconnect();
		} catch {}
		try {
			workletNode && workletNode.disconnect();
		} catch {}
		try {
			silentGain && silentGain.disconnect();
		} catch {}
		try {
			audioCtx && audioCtx.close();
		} catch {}
		if (workletUrl) {
			try {
				URL.revokeObjectURL(workletUrl);
			} catch {}
			workletUrl = null;
		}
		try {
			mediaStream?.getTracks()?.forEach((t) => t.stop());
		} catch {}

		audioCtx = null;
		workletNode = null;
		srcNode = null;
		silentGain = null;
		mediaStream = null;
		isRecording = false;
		log('녹음 중지');
		if (!skipEnd) send('openai:conversation', 'input_audio_buffer.end');
	}

	function sendText() {
		const text = inputText.trim();
		if (!text) return;
		send('openai:conversation', 'input_text', { text });
		messages = [...messages, { id: uid(), role: 'user', text }];
		inputText = '';
	}

	// ===== WAV build helpers for server→client PCM16 =====
	const WAV_SR = 24000,
		WAV_CH = 1,
		BYTES_PER_SAMPLE = 2;
	function concatInt16Chunks(chunks) {
		let total = 0;
		for (const c of chunks) total += c.length;
		const out = new Int16Array(total);
		let o = 0;
		for (const c of chunks) {
			out.set(c, o);
			o += c.length;
		}
		return out;
	}
	function int16ToBytesLE(int16) {
		// returns Uint8Array view
		return new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
	}
	function buildWavFromInt16(int16) {
		const dataBytes = int16.length * BYTES_PER_SAMPLE;
		const buffer = new ArrayBuffer(44 + dataBytes);
		const view = new DataView(buffer);
		let p = 0;
		function writeStr(s) {
			for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
		}
		function write32(v) {
			view.setUint32(p, v, true);
			p += 4;
		}
		function write16(v) {
			view.setUint16(p, v, true);
			p += 2;
		}

		writeStr('RIFF');
		write32(36 + dataBytes);
		writeStr('WAVE');
		writeStr('fmt ');
		write32(16); // PCM fmt chunk size
		write16(1); // audio format = PCM
		write16(WAV_CH); // channels
		write32(WAV_SR); // sample rate
		write32(WAV_SR * WAV_CH * BYTES_PER_SAMPLE); // byte rate
		write16(WAV_CH * BYTES_PER_SAMPLE); // block align
		write16(16); // bits per sample
		writeStr('data');
		write32(dataBytes);

		// PCM payload
		const bytes = int16ToBytesLE(int16);
		new Uint8Array(buffer, 44).set(bytes);
		return new Blob([buffer], { type: 'audio/wav' });
	}

	function stitchIfNeeded(stream, idx) {
		if (stream.audioUrl || stream.pcmChunks.length === 0) return;
		if (stream.stitchTimer) return;
		stream.stitchTimer = setTimeout(() => {
			if (stream.audioUrl) URL.revokeObjectURL(stream.audioUrl);
			const all = concatInt16Chunks(stream.pcmChunks);
			const wav = buildWavFromInt16(all);
			stream.audioUrl = URL.createObjectURL(wav);
			if (stream.stitchTimer) {
				clearTimeout(stream.stitchTimer);
				stream.stitchTimer = null;
			}
			syncAssistantView(idx);
		}, 900); // 약간 더 짧게
	}

	async function onMessage(evt) {
		// Binary audio frames from server (PCM16 @ 24kHz)
		if (evt && evt.data && (evt.data instanceof ArrayBuffer || evt.data instanceof Blob)) {
			const buf = evt.data instanceof Blob ? await evt.data.arrayBuffer() : evt.data;
			const pcm = new Int16Array(buf);
			const idx = lastOutputIndex;
			const s = ensureStream(idx);
			s.pcmChunks.push(pcm);
			stitchIfNeeded(s, idx);
			log(`수신 ← PCM16 chunk (${pcm.length} samples)`);
			return;
		}

		// JSON control frames (valid by server contract)
		const data = JSON.parse(evt.data);
		const channel = data.channel;
		const type = data.type;

		if (channel === 'openai:conversation') {
			switch (type) {
				case 'response.audio_transcript.delta': {
					const idx = getDisplayIdx(data.output_index);
					const s = ensureStream(idx);
					s.transcript += data.delta;
					lastOutputIndex = idx;
					syncAssistantView(idx);
					break;
				}
				case 'response.text.delta': {
					const idx = getDisplayIdx(data.output_index);
					const s = ensureStream(idx);
					s.text += data.delta;
					lastOutputIndex = idx;
					syncAssistantView(idx);
					break;
				}
				case 'response.audio.delta': {
					// 서버가 JSON 안에 바이너리를 안 넣는 구성이라면 이 케이스는 통과
					break;
				}
				case 'response.text.done': {
					const idx = getDisplayIdx(data.output_index);
					ensureStream(idx).done.text = true;
					break;
				}
				case 'response.audio_transcript.done': {
					const idx = getDisplayIdx(data.output_index);
					ensureStream(idx).done.transcript = true;
					break;
				}
				case 'response.audio.done': {
					const idx = getDisplayIdx(data.output_index);
					const s = ensureStream(idx);
					s.done.audio = true;
					// finalize WAV
					if (s.audioUrl) URL.revokeObjectURL(s.audioUrl);
					const all = concatInt16Chunks(s.pcmChunks);
					const wav = buildWavFromInt16(all);
					s.audioUrl = URL.createObjectURL(wav);
					if (s.stitchTimer) {
						clearTimeout(s.stitchTimer);
						s.stitchTimer = null;
					}
					syncAssistantView(idx);
					break;
				}
				case 'preprompted.done': {
					// 서버가 output_index를 주지 않는 스펙이라 응답 위치가 흔들렸음.
					// 사용자가 버튼을 누른 순간 예약해둔 pendingPrepromptIdx에 꽂아 넣는다.
					const idx =
						typeof data.output_index === 'number'
							? getDisplayIdx(data.output_index)
							: (pendingPrepromptIdx ?? lastOutputIndex);
					const s = ensureStream(idx);
					const add = data.output || '';
					if (add) {
						s.text += (s.text && !s.text.endsWith('\n') ? '\n' : '') + add;
						syncAssistantView(idx);
					}
					// 소비 완료
					pendingPrepromptIdx = null;
					break;
				}
				default:
			}
			return;
		}

		if (channel === 'sonju:suggestedQuestion') {
			if (type === 'suggestion.response') {
				suggestions = Array.isArray(data.questions) ? data.questions : [];
			}
			return;
		}
		if (channel === 'sonju:officeInfo') {
			if (type === 'officeInfo') {
				officeInfo = { tel: data.tel, pos: data.pos };
			}
			return;
		}
		if (channel === 'sonju:summarize') {
			if (type === 'summary.image') {
				if (data.image_base64)
					summaryImage = { src: `data:image/png;base64,${data.image_base64}`, kind: 'base64' };
				else if (data.image_url) summaryImage = { src: data.image_url, kind: 'url' };
			}
			return;
		}
	}

	function clickSuggestion(q) {
		inputText = q;
		sendText();
	}
	function resetAll() {
		revokeAudioUrls();
		streams.clear();
		serverToDisplay.clear();
		displaySeq = 0;
		lastOutputIndex = 0;
		messages = [];
		summaryImage = null;
		suggestions = [];
		officeInfo = null;
		errorLog = [];
		eventLog = [];
	}

	import { onMount, onDestroy } from 'svelte';
	onMount(() => {
		refreshAudioInputs();
		navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioInputs);
	});
	onDestroy(() => {
		stopRecording(true);
		revokeAudioUrls();
		ws && ws.close();
		navigator.mediaDevices?.removeEventListener?.('devicechange', refreshAudioInputs);
	});
</script>

<div class="wrap">
	<header>
		<div class="urlbox">
			<span class="status-dot" data-on={connected}></span>
			<input bind:value={wsUrl} placeholder="ws://host:port" />
			{#if !connected}
				<button class="btn btn-primary" on:click={connect}>연결</button>
			{:else}
				<button class="btn btn-danger" on:click={disconnect}>연결 해제</button>
			{/if}
			<button class="btn" on:click={resetAll}>초기화</button>
		</div>

		<div class="right">
			<select
				class="btn"
				bind:value={selectedDeviceId}
				title="입력 장치 선택"
				style="max-width:260px;"
			>
				{#if audioInputs.length === 0}
					<option value="">사용 가능한 마이크 없음</option>
				{:else}
					{#each audioInputs as d}
						<option value={d.deviceId}>{d.label}</option>
					{/each}
				{/if}
			</select>
			<button class="btn" on:click={ensureMicPermission} title="권한 요청">🔒 권한 요청</button>
			<button class="btn" on:click={refreshAudioInputs} title="장치 새로고침">🔄</button>
		</div>
	</header>

	<div class="row">
		<!-- LEFT: Chat -->
		<section class="card chat">
			<div class="chat-head">
				<strong>대화</strong>
				<span class="kv">output_index: {lastOutputIndex}</span>
			</div>

			<div class="chat-body">
				{#each messages as m (m.id)}
					<div class="msg">
						<h5>{m.role === 'user' ? '나' : '응답'}{m.idx !== undefined ? ` #${m.idx}` : ''}</h5>

						{#if m.role === 'assistant'}
							{#if m.transcript}
								<div><small class="kv">음성→텍스트(동기)</small></div>
								<div class="mono">{m.transcript}</div>
							{/if}

							{#if m.text}
								<div style="margin-top:8px;"><small class="kv">답변 텍스트</small></div>
								<div class="mono">{m.text}</div>
							{/if}

							{#if m.audioUrl}
								<div class="audio"><audio controls autoplay src={m.audioUrl}></audio></div>
							{/if}
						{:else if m.text}
							<div class="mono">{m.text}</div>
						{:else}
							<div class="mono">…</div>
						{/if}
					</div>
				{/each}
			</div>

			<!-- 입력줄: 버튼이 같은 행에 고정됨 -->
			<div class="chat-input">
				<div class="field">
					<input
						bind:value={inputText}
						placeholder="질문을 입력하고 Enter…"
						on:keydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								sendText();
							}
						}}
					/>
				</div>
				{#if !isRecording}
					<button class="btn" on:click={startRecording}>🎙️ 녹음 시작</button>
				{:else}
					<button class="btn btn-danger" on:click={stopRecording}>⏹ 녹음 끝</button>
				{/if}
				<button class="btn" on:click={sendText}>전송</button>
			</div>
		</section>

		<!-- RIGHT: Panels -->
		<div class="panel-col">
			<section class="card">
				<div class="panels-head"><strong>손주</strong></div>
				<div class="pane-body">
					<div class="chips" style="flex-wrap:wrap;gap:8px;">
						{#each preprompts as p}
							<button class="chip" on:click={() => sendPreprompt(p)}>{p}</button>
						{/each}
						<button class="chip" on:click={requestSummary}>요약 요청</button>
					</div>
				</div>
			</section>
			<section class="card panels">
				<div class="panels-head"><strong>요약 / 제안</strong></div>
				<div class="pane-body">
					<div class="grid2">
						<div>
							<div><small class="kv">요약 이미지</small></div>
							{#if summaryImage}
								<img
									src={summaryImage.src}
									alt="summary"
									style="max-width:100%;border-radius:8px;border:1px solid var(--border);"
								/>
							{:else}
								<div class="kv">아직 없음</div>
							{/if}
						</div>
						<div>
							<div><small class="kv">다음 질문 제안</small></div>
							{#if suggestions.length}
								<div class="chips" style="margin-top:6px;flex-wrap:wrap;">
									{#each suggestions as s}
										<button class="chip" on:click={() => clickSuggestion(s)}>{s}</button>
									{/each}
								</div>
							{:else}
								<div class="kv">아직 없음</div>
							{/if}
						</div>
					</div>
				</div>
			</section>

			<section class="card panels">
				<div class="panels-head"><strong>동사무소 정보 / 로그</strong></div>
				<div class="pane-body">
					<div class="office">
						<div><small class="kv">동사무소 정보</small></div>
						{#if officeInfo}
							<div>☎ {officeInfo.tel}</div>
							{#if officeInfo.pos && officeInfo.pos.length === 2}
								<div>📍 {officeInfo.pos[0]}, {officeInfo.pos[1]}</div>
								<a
									target="_blank"
									href={'https://maps.google.com/?q=' + officeInfo.pos[0] + ',' + officeInfo.pos[1]}
									>지도 열기</a
								>
							{/if}
						{:else}
							<div class="kv">아직 없음</div>
						{/if}
					</div>

					<div style="margin-top:12px;">
						<div><small class="kv">에러</small></div>
						<div class="logs error">{errorLog.join('\n') || '—'}</div>
					</div>

					<div style="margin-top:12px;">
						<div><small class="kv">이벤트 로그</small></div>
						<div class="logs">{eventLog.join('\n') || '—'}</div>
					</div>
				</div>
			</section>
		</div>
	</div>
</div>

<style>
	:global(:root) {
		--bg: #f5f5f7;
		--panel: #fff;
		--muted: #888;
		--text: #222;
		--accent: #4da3ff;
		--danger: #ff6363;
		--ok: #5bd28b;
		--border: #e0e0e0;
		--font-body:
			'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Nanum Gothic', Segoe UI, Roboto,
			Arial, sans-serif;
	}
	* {
		box-sizing: border-box;
	}
	:global(input),
	:global(button),
	:global(select) {
		font-family: inherit;
	}
	:global(html),
	:global(body),
	:global(#app) {
		height: 100%;
	}
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--text);
		font: 14px/1.5 var(--font-body);
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
		text-rendering: optimizeLegibility;
	}

	:global(strong),
	:global(b) {
		font-weight: 600;
		font-synthesis-weight: none;
	}
	.wrap {
		height: 100vh;
		display: grid;
		grid-template-rows: 64px 1fr;
		gap: 10px;
		padding: 10px;
	}
	header {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 10px;
		align-items: center;
	}
	.card {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 12px;
		overflow: hidden;
		color: var(--text);
	}
	.row {
		display: grid;
		grid-template-columns: 2fr 1fr;
		gap: 10px;
		min-height: 0;
	}
	.chat {
		display: grid;
		grid-template-rows: 40px 1fr 64px;
		gap: 8px;
		min-height: 0;
	}
	.chat-head,
	.panels-head {
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
		background: var(--panel);
		color: var(--text);
	}
	.chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.chip,
	button,
	.btn {
		background: #fff;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 8px 12px;
		border-radius: 9px;
		cursor: pointer;
		transition: 0.15s;
		white-space: nowrap;
	}
	.chip:hover,
	button:hover {
		border-color: var(--accent);
		background: #f0f7ff;
		color: var(--accent);
	}
	.btn-primary {
		border-color: var(--accent);
	}
	.btn-danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--danger);
	}
	.status-dot[data-on='true'] {
		background: var(--ok);
	}
	.chat-body {
		padding: 12px;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 12px;
		background: var(--panel);
		color: var(--text);
	}
	.msg {
		background: #f7f7f7;
		border: 1px solid var(--border);
		padding: 10px 12px;
		border-radius: 10px;
		color: var(--text);
	}
	.msg h5 {
		margin: 0 0 6px;
		font-weight: 600;
		color: var(--muted);
	}
	.msg .mono {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		white-space: pre-wrap;
		color: var(--text);
	}
	.chat-input {
		padding: 8px;
		border-top: 1px solid var(--border);
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 8px;
		align-items: center;
		background: var(--panel);
	}
	.field {
		display: flex;
		gap: 8px;
		background: #fff;
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		align-items: center;
		min-width: 0;
	}
	.field input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: 0;
		outline: none;
		color: var(--text);
		padding: 6px;
	}
	.panel-col {
		display: grid;
		grid-template-rows: auto 1fr 1fr;
		gap: 10px;
		min-height: 0;
	}
	.panels {
		display: grid;
		grid-template-rows: 32px 1fr;
		min-height: 0;
	}
	.pane-body {
		padding: 10px;
		overflow: auto;
		height: 100%;
		color: var(--text);
		background: var(--panel);
	}
	.grid2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.kv {
		color: var(--muted);
	}
	.error {
		color: var(--danger);
	}
	.logs {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 12px;
		white-space: pre-wrap;
		color: var(--text);
		background: #f7f7f7;
		border-radius: 6px;
		padding: 6px;
		border: 1px solid var(--border);
	}
	.audio {
		margin-top: 6px;
	}
	.office {
		display: grid;
		gap: 6px;
	}
	.office a {
		color: var(--accent);
		text-decoration: none;
	}
	header .right {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.urlbox {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.urlbox input {
		width: 380px;
		background: #fff;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 8px 10px;
		border-radius: 9px;
	}
	select.btn {
		appearance: none;
		-webkit-appearance: none;
		background: #fff;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 8px 12px;
		border-radius: 9px;
	}
</style>
