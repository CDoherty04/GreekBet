"use client";

/**
 * PhotoCapture — capture a photo from the camera, with a file-upload fallback.
 *
 * Reused for both the signup selfie (World Selfie Check) and the market
 * resolution photo (AI resolver). Emits a base64 data URL via `onCapture`.
 *
 * Camera access needs a secure context (https or localhost). If it isn't
 * available (or the user denies it), we fall back to the native file picker,
 * which on phones still opens the camera.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";

interface PhotoCaptureProps {
  onCapture: (dataUrl: string) => void;
  /** "user" = front camera (selfie), "environment" = rear camera. */
  facingMode?: "user" | "environment";
  /** Label for the capture button. */
  captureLabel?: string;
}

export function PhotoCapture({
  onCapture,
  facingMode = "user",
  captureLabel = "Capture",
}: PhotoCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch {
      setError("Camera unavailable — upload a photo instead.");
    }
  }, [facingMode]);

  // Clean up the camera stream on unmount.
  useEffect(() => () => stopCamera(), [stopCamera]);

  const takePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    setPreview(dataUrl);
    onCapture(dataUrl);
    stopCamera();
  }, [onCapture, stopCamera]);

  const onFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setPreview(dataUrl);
        onCapture(dataUrl);
      };
      reader.readAsDataURL(file);
    },
    [onCapture],
  );

  const retake = useCallback(() => {
    setPreview(null);
    void startCamera();
  }, [startCamera]);

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative aspect-square w-full max-w-xs overflow-hidden rounded-3xl border border-border bg-surface-2">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="Captured"
            className="h-full w-full object-cover"
          />
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            className={[
              "h-full w-full object-cover",
              cameraOn ? "" : "opacity-0",
              facingMode === "user" ? "-scale-x-100" : "",
            ].join(" ")}
          />
        )}
        {!preview && !cameraOn && (
          <div className="absolute inset-0 flex items-center justify-center text-muted">
            <span className="text-sm">Camera off</span>
          </div>
        )}
      </div>

      {error && <p className="text-center text-sm text-no">{error}</p>}

      <div className="w-full space-y-2">
        {preview ? (
          <Button variant="secondary" onClick={retake}>
            Retake
          </Button>
        ) : cameraOn ? (
          <Button onClick={takePhoto}>{captureLabel}</Button>
        ) : (
          <Button onClick={startCamera}>Open camera</Button>
        )}

        <label className="block">
          <span className="flex w-full cursor-pointer items-center justify-center rounded-2xl border border-border bg-surface-2 px-5 py-3 text-sm font-medium text-muted hover:text-foreground">
            Or upload a photo
          </span>
          <input
            type="file"
            accept="image/*"
            capture={facingMode}
            onChange={onFile}
            className="hidden"
          />
        </label>
      </div>
    </div>
  );
}
