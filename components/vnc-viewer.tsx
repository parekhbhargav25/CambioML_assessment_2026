"use client";

import { memo } from "react";
import { Button } from "@/components/ui/button";

type VncViewerProps = {
  streamUrl: string | null;
  isInitializing: boolean;
  onRefresh: () => void;
};

const VncViewerComponent = ({
  streamUrl,
  isInitializing,
  onRefresh,
}: VncViewerProps) => {
  return (
    <div className="relative h-full w-full bg-black">
      {streamUrl ? (
        <>
          <iframe
            src={streamUrl}
            className="w-full h-full"
            style={{
              transformOrigin: "center",
              width: "100%",
              height: "100%",
            }}
            allow="autoplay"
          />
          <Button
            onClick={onRefresh}
            className="absolute top-3 right-3 bg-black/60 hover:bg-black/80 text-white px-3 py-1 rounded text-sm z-10"
            disabled={isInitializing}
          >
            {isInitializing ? "Creating desktop..." : "New desktop"}
          </Button>
        </>
      ) : (
        <div className="flex items-center justify-center h-full text-white">
          {isInitializing ? "Initializing desktop..." : "Loading stream..."}
        </div>
      )}
    </div>
  );
};

export const VncViewer = memo(
  VncViewerComponent,
  (prev, next) =>
    prev.streamUrl === next.streamUrl &&
    prev.isInitializing === next.isInitializing &&
    prev.onRefresh === next.onRefresh,
);
