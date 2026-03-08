import { useEffect, useRef, useState, useCallback } from "react";

export default function VoiceIndicator({ wsRef }) {
  const [status, setStatus] = useState("idle"); // idle | listening | speaking
  const [transcript, setTranscript] = useState("");
  const audioCtxRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const processorRef = useRef(null);
  const playbackCtxRef = useRef(null);

  const startListening = useCallback(async () => {
    if (status === "listening") {
      // Stop listening
      stopListening();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
          return;

        const pcm = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, pcm[i] * 32768));
        }

        const bytes = new Uint8Array(int16.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(binary);
        wsRef.current.send(JSON.stringify({ type: "audio", data: b64 }));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
      setStatus("listening");
    } catch (err) {
      console.error("[Cortex] Mic access error:", err);
    }
  }, [status, wsRef]);

  function stopListening() {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    setStatus("idle");
  }

  // Play back audio from Gemini
  const playAudio = useCallback(async (b64Data) => {
    try {
      if (!playbackCtxRef.current) {
        playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
      }
      const ctx = playbackCtxRef.current;

      const binary = atob(b64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => setStatus("listening");
      source.start();
    } catch (err) {
      console.error("[Cortex] Audio playback error:", err);
    }
  }, []);

  // Handle incoming messages
  useEffect(() => {
    if (!wsRef.current) return;

    const handleMessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "audio") {
          setStatus("speaking");
          playAudio(msg.data);
        }
        if (msg.type === "transcript") {
          setTranscript(msg.text);
          // Clear transcript after 8 seconds
          setTimeout(() => setTranscript(""), 8000);
        }
      } catch (err) {
        // not JSON, ignore
      }
    };

    wsRef.current.addEventListener("message", handleMessage);
    return () => {
      if (wsRef.current) {
        wsRef.current.removeEventListener("message", handleMessage);
      }
    };
  }, [wsRef, playAudio]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListening();
      if (playbackCtxRef.current) {
        playbackCtxRef.current.close();
      }
    };
  }, []);

  const pulseAnimation =
    status === "listening"
      ? "2px solid #4af0b0"
      : status === "speaking"
      ? "2px solid #f0c14a"
      : "1px solid #4af0b033";

  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 20 }}>
      <button
        onClick={startListening}
        style={{
          background:
            status === "speaking"
              ? "#f0c14a"
              : status === "listening"
              ? "#4af0b0"
              : "#1a1e2a",
          border: pulseAnimation,
          borderRadius: "50%",
          width: 56,
          height: 56,
          cursor: "pointer",
          boxShadow:
            status !== "idle"
              ? `0 0 20px ${status === "speaking" ? "rgba(240,193,74,0.5)" : "rgba(74,240,176,0.5)"}`
              : "none",
          transition: "all 0.3s ease",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          color: status !== "idle" ? "#0a0e14" : "#4af0b0",
        }}
        title={
          status === "idle"
            ? "Click to start talking to Cortex"
            : status === "listening"
            ? "Listening... click to stop"
            : "Cortex is speaking..."
        }
      >
        {status === "listening" ? "\u{1F3A4}" : status === "speaking" ? "\u{1F50A}" : "\u{1F3A4}"}
      </button>

      {/* Status label */}
      <div
        style={{
          textAlign: "center",
          marginTop: 6,
          fontSize: 10,
          color: "#8b949e",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        {status}
      </div>

      {/* Transcript bubble */}
      {transcript && (
        <div
          style={{
            position: "absolute",
            bottom: 80,
            right: 0,
            width: 300,
            background: "rgba(13, 17, 23, 0.95)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 8,
            padding: 14,
            fontSize: 12,
            color: "#c8d0e0",
            lineHeight: 1.5,
            backdropFilter: "blur(12px)",
            boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
          }}
        >
          {transcript}
        </div>
      )}
    </div>
  );
}
