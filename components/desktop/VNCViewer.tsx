'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Maximize2,
  Minimize2,
  XCircle,
  LogOut,
  RefreshCw,
  Keyboard,
  Users,
  Clipboard,
  ClipboardCopy,
  ClipboardPaste,
  Check,
} from 'lucide-react';
import { Menu, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { Button, Spinner, Card } from '@/components/ui';
import { ShareSession } from './ShareSession';
import { useSessionStore, toast } from '@/lib/stores';
import { ROUTES, SUCCESS_MESSAGES, API_BASE_URL } from '@/lib/utils/constants';
import { cn, getAccessToken } from '@/lib/utils/helpers';
import { api } from '@/lib/api';

interface VNCViewerProps {
  sessionId: string;
  websocketUrl: string;
  isOwner?: boolean;
  viewOnly?: boolean;
}

interface Viewer {
  odId: string;
  name?: string;
  permissions: 'view' | 'control';
  joinedAt: Date;
  isOwner: boolean;
}

/** The subset of the noVNC RFB object that vnc.html exposes to this page */
interface VncFrameWindow extends Window {
  vncRFB?: {
    disconnect(): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
  };
}

/** Build the absolute WebSocket URL for the VNC proxy (API may be same-origin) */
function buildVncWebSocketUrl(path: string, token: string): string {
  const base = (API_BASE_URL || window.location.origin).replace(/^http/, 'ws');
  const separator = path.includes('?') ? '&' : '?';
  return `${base}${path}${separator}token=${encodeURIComponent(token)}`;
}

export function VNCViewer({ sessionId, websocketUrl, isOwner = true, viewOnly = false }: VNCViewerProps) {
  const router = useRouter();
  const { disconnect } = useSessionStore();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showToolbar, setShowToolbar] = useState(true);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [viewerCount, setViewerCount] = useState(0);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const maxReconnectAttempts = 3;
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [remoteClipboard, setRemoteClipboard] = useState<string>('');
  const [clipboardCopied, setClipboardCopied] = useState(false);

  // vnc.html only needs non-secret display options in its URL
  const frameParams = new URLSearchParams();
  if (viewOnly) frameParams.set('viewOnly', '1');
  if (isOwner) frameParams.set('resize', '1');
  const frameQuery = frameParams.toString();
  const frameSrc = frameQuery ? `/vnc.html?${frameQuery}` : '/vnc.html';

  const getFrameWindow = useCallback((): VncFrameWindow | null => {
    return (iframeRef.current?.contentWindow as VncFrameWindow | null) ?? null;
  }, []);

  const reloadFrame = useCallback(() => {
    if (iframeRef.current) {
      // Reassigning src reloads the frame, which starts a fresh RFB handshake
      iframeRef.current.src = frameSrc;
    }
  }, [frameSrc]);

  // Hand the WebSocket URL (which carries the access token) to the frame once it
  // has loaded. Reading the token here, rather than when the page first renders,
  // means reconnects pick up a token the API client may have refreshed since.
  const handleFrameLoad = useCallback(() => {
    const frameWindow = getFrameWindow();
    if (!frameWindow) return;

    const token = getAccessToken();
    if (!token) {
      setError('Authentication required. Please log in again.');
      setIsConnecting(false);
      return;
    }

    frameWindow.postMessage(
      { type: 'vnc-connect', url: buildVncWebSocketUrl(websocketUrl, token) },
      window.location.origin
    );
  }, [getFrameWindow, websocketUrl]);

  // Check if session is recoverable and attempt auto-reconnect
  const attemptAutoReconnect = useCallback(async () => {
    if (reconnectAttempt >= maxReconnectAttempts) {
      setIsReconnecting(false);
      setError('Connection lost. Maximum reconnection attempts reached.');
      return;
    }
    setIsReconnecting(true);
    const attempt = reconnectAttempt + 1;
    setReconnectAttempt(attempt);
    try {
      const response = await api.get<{ isRecoverable: boolean; status: string; reason?: string }>(
        `/api/sessions/${sessionId}/status`
      );
      if (response.success && response.data?.isRecoverable) {
        toast.info(`Reconnecting... (attempt ${attempt}/${maxReconnectAttempts})`);
        const delay = Math.pow(2, attempt - 1) * 1000;
        reconnectTimeoutRef.current = setTimeout(() => {
          setIsConnecting(true);
          setError(null);
          reloadFrame();
        }, delay);
      } else {
        setIsReconnecting(false);
        setError(response.data?.reason || 'Session is no longer available.');
      }
    } catch {
      setIsReconnecting(false);
      setError('Connection lost. Unable to verify session status.');
    }
  }, [sessionId, reconnectAttempt, reloadFrame]);

  // Cleanup reconnect timeout on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  // Fetch viewer count
  useEffect(() => {
    const fetchViewers = async () => {
      try {
        const response = await api.get<{
          viewerCount: number;
          viewers: Viewer[];
        }>(`/api/sessions/${sessionId}/viewers`);
        if (response.success && response.data) {
          setViewerCount(response.data.viewerCount);
          setViewers(response.data.viewers);
        }
      } catch {
        // Viewer list is informational; keep the last known value
      }
    };

    if (isConnected) {
      fetchViewers();
      // Poll for viewer updates every 10 seconds
      const interval = setInterval(fetchViewers, 10000);
      return () => clearInterval(interval);
    }
  }, [sessionId, isConnected]);

  // Listen for messages from the VNC frame (same origin only)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      const data = event.data as { type?: string; clean?: boolean; error?: string; text?: string };
      if (data?.type === 'vnc-connected') {
        setIsConnected(true);
        setIsConnecting(false);
        setIsReconnecting(false);
        setReconnectAttempt(0);
        setError(null);
      } else if (data?.type === 'vnc-disconnected') {
        setIsConnected(false);
        setIsConnecting(false);
        if (data.clean) {
          toast.info('Disconnected from remote desktop');
        } else {
          attemptAutoReconnect();
        }
      } else if (data?.type === 'vnc-error') {
        setError(data.error || 'VNC connection error');
        setIsConnecting(false);
      } else if (data?.type === 'vnc-clipboard') {
        setRemoteClipboard(data.text || '');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [attemptAutoReconnect]);

  const handleDisconnect = useCallback(async () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    setIsReconnecting(false);
    setReconnectAttempt(0);

    // Close our own VNC connection first
    getFrameWindow()?.vncRFB?.disconnect();

    // Viewers only leave; ending the session is the owner's call
    if (!isOwner) {
      router.push(ROUTES.DASHBOARD);
      return;
    }

    try {
      await disconnect(sessionId);
      toast.success(SUCCESS_MESSAGES.DISCONNECTION_SUCCESS);
      router.push(ROUTES.DASHBOARD);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to disconnect';
      toast.error(message);
    }
  }, [sessionId, isOwner, disconnect, router, getFrameWindow]);

  const handleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    setIsReconnecting(false);
    setReconnectAttempt(0);
    setIsConnecting(true);
    setError(null);
    reloadFrame();
  }, [reloadFrame]);

  const toggleFullscreen = useCallback(async () => {
    const container = document.getElementById('vnc-container');
    if (!document.fullscreenElement && container) {
      await container.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  }, []);

  const sendCtrlAltDel = useCallback(() => {
    getFrameWindow()?.vncRFB?.sendCtrlAltDel();
  }, [getFrameWindow]);

  // Copy remote clipboard to local
  const copyFromRemote = useCallback(async () => {
    if (!remoteClipboard) {
      toast.error('No clipboard data from remote');
      return;
    }
    try {
      await navigator.clipboard.writeText(remoteClipboard);
      setClipboardCopied(true);
      toast.success('Copied from remote clipboard');
      setTimeout(() => setClipboardCopied(false), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }, [remoteClipboard]);

  // Paste local clipboard to remote
  const pasteToRemote = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      const rfb = getFrameWindow()?.vncRFB;
      if (rfb) {
        rfb.clipboardPasteFrom(text);
        toast.success('Pasted to remote clipboard');
      }
    } catch {
      toast.error('Failed to read clipboard. Allow clipboard access in browser.');
    }
  }, [getFrameWindow]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      // Always start (and leave) fullscreen with the toolbar visible
      setShowToolbar(true);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Auto-hide toolbar in fullscreen
  useEffect(() => {
    if (!isFullscreen) {
      return;
    }

    let timeout: NodeJS.Timeout;
    const handleMouseMove = () => {
      setShowToolbar(true);
      clearTimeout(timeout);
      timeout = setTimeout(() => setShowToolbar(false), 3000);
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      clearTimeout(timeout);
    };
  }, [isFullscreen]);

  return (
    <div
      id="vnc-container"
      className={cn('relative h-full bg-black', isFullscreen && 'fixed inset-0 z-50')}
    >
      {/* Toolbar */}
      <div
        className={cn(
          'absolute top-0 left-0 right-0 z-10 bg-card/90 backdrop-blur-sm border-b border-border transition-transform duration-200',
          isFullscreen && !showToolbar && '-translate-y-full'
        )}
      >
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'w-2 h-2 rounded-full',
                  isConnected ? 'bg-status-success animate-pulse' : isReconnecting ? 'bg-status-warning animate-pulse' : 'bg-status-warning'
                )}
              />
              <span className="text-sm text-foreground">
                {isConnected ? 'Connected' : isReconnecting ? `Reconnecting (${reconnectAttempt}/${maxReconnectAttempts})...` : isConnecting ? 'Connecting...' : 'Disconnected'}
              </span>
            </div>

            {viewOnly && (
              <span className="text-xs text-muted-foreground px-2 py-1 bg-muted/50 rounded-md">View only</span>
            )}

            {/* Viewer indicator */}
            {viewerCount > 0 && (
              <div
                className="flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded-md"
                title={`${viewerCount} viewer(s) connected`}
              >
                <Users className="w-3.5 h-3.5 text-status-success" />
                <span className="text-xs text-foreground font-medium">{viewerCount}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Share button - only for owner */}
            {isOwner && (
              <ShareSession sessionId={sessionId} isOwner={isOwner} />
            )}
            {/* Clipboard sync dropdown */}
            <Menu as="div" className="relative">
              <Menu.Button as="div">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!isConnected}
                  title="Clipboard Sync"
                >
                  {clipboardCopied ? (
                    <Check className="w-4 h-4 text-status-success" />
                  ) : (
                    <Clipboard className="w-4 h-4" />
                  )}
                </Button>
              </Menu.Button>
              <Transition
                as={Fragment}
                enter="transition ease-out duration-100"
                enterFrom="transform opacity-0 scale-95"
                enterTo="transform opacity-100 scale-100"
                leave="transition ease-in duration-75"
                leaveFrom="transform opacity-100 scale-100"
                leaveTo="transform opacity-0 scale-95"
              >
                <Menu.Items className="absolute right-0 mt-1 w-56 origin-top-right rounded-lg bg-card border border-border shadow-lg focus:outline-none overflow-hidden z-50">
                  <div className="p-1">
                    <Menu.Item>
                      {({ active }) => (
                        <button
                          onClick={copyFromRemote}
                          className={cn(
                            'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors',
                            active ? 'bg-muted text-foreground' : 'text-muted-foreground'
                          )}
                        >
                          <ClipboardCopy className="w-4 h-4" />
                          Copy from Remote
                          {remoteClipboard && (
                            <span className="ml-auto text-xs text-status-success">Has data</span>
                          )}
                        </button>
                      )}
                    </Menu.Item>
                    {!viewOnly && (
                      <Menu.Item>
                        {({ active }) => (
                          <button
                            onClick={pasteToRemote}
                            className={cn(
                              'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors',
                              active ? 'bg-muted text-foreground' : 'text-muted-foreground'
                            )}
                          >
                            <ClipboardPaste className="w-4 h-4" />
                            Paste to Remote
                          </button>
                        )}
                      </Menu.Item>
                    )}
                  </div>
                </Menu.Items>
              </Transition>
            </Menu>
            {!viewOnly && (
              <Button
                variant="ghost"
                size="sm"
                onClick={sendCtrlAltDel}
                disabled={!isConnected}
                title="Send Ctrl+Alt+Del"
              >
                <Keyboard className="w-4 h-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReconnect}
              disabled={isConnecting}
              title="Reconnect"
            >
              <RefreshCw className={cn('w-4 h-4', (isConnecting || isReconnecting) && 'animate-spin')} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <Minimize2 className="w-4 h-4" />
              ) : (
                <Maximize2 className="w-4 h-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-status-error hover:bg-status-error/10"
              onClick={handleDisconnect}
              title={isOwner ? 'Disconnect' : 'Leave session'}
            >
              {isOwner ? <XCircle className="w-4 h-4" /> : <LogOut className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </div>

      {/* VNC Iframe */}
      <iframe
        ref={iframeRef}
        src={frameSrc}
        onLoad={handleFrameLoad}
        className={cn(
          'w-full h-full border-0',
          isFullscreen ? 'pt-0' : 'pt-12'
        )}
        allow="fullscreen"
      />

      {/* Loading overlay */}
      {(isConnecting || isReconnecting) && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 pt-12">
          <div className="flex flex-col items-center gap-4">
            <Spinner size="lg" className="text-white" />
            <p className="text-white text-sm">{isReconnecting ? `Reconnecting (attempt ${reconnectAttempt}/${maxReconnectAttempts})...` : 'Connecting to remote desktop...'}</p>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && !isReconnecting && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 pt-12">
          <Card className="max-w-md text-center">
            <div className="p-8">
              <XCircle className="w-12 h-12 text-status-error mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-foreground mb-2">
                Connection Error
              </h2>
              <p className="text-muted-foreground mb-6">{error}</p>
              <div className="flex justify-center gap-3">
                <Button variant="outline" onClick={() => router.push(ROUTES.DASHBOARD)}>
                  Back to Dashboard
                </Button>
                <Button onClick={handleReconnect}>
                  Try Again
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
