import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * Minimal react-native-webview stand-in for the web build (Expo web has no
 * WebView). Renders the HTML in a same-origin iframe, provides
 * `window.ReactNativeWebView.postMessage`, and supports `injectJavaScript`
 * and `reload`, which is everything this app uses.
 */
interface ShimProps {
  source?: { html?: string; uri?: string };
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
  style?: StyleProp<ViewStyle>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface WebViewShimRef {
  injectJavaScript: (js: string) => void;
  reload: () => void;
}

let nextId = 0;

export const WebView = forwardRef<WebViewShimRef, ShimProps>(function WebView({ source, onMessage, style }, ref) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const id = useMemo(() => `rnwv-${++nextId}`, []);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const srcDoc = useMemo(() => {
    const bridge = `<script>window.ReactNativeWebView={postMessage:function(d){parent.postMessage({__rnwv:${JSON.stringify(
      id
    )},data:String(d)},'*')}};</script>`;
    const html = source?.html ?? '';
    return html.includes('<head>') ? html.replace('<head>', `<head>${bridge}`) : bridge + html;
  }, [source?.html, id]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data && event.data.__rnwv === id) {
        onMessageRef.current?.({ nativeEvent: { data: event.data.data } });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [id]);

  useImperativeHandle(ref, () => ({
    injectJavaScript: (js: string) => {
      const win = frameRef.current?.contentWindow as (Window & { eval: (code: string) => unknown }) | null;
      try {
        win?.eval(js);
      } catch (e) {
        console.warn('[WebViewShim] inject failed', e);
      }
    },
    reload: () => {
      if (frameRef.current) frameRef.current.srcdoc = srcDoc;
    },
  }));

  const flat = (Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity as 1)) : style) as React.CSSProperties;
  return React.createElement('iframe', {
    ref: frameRef,
    srcDoc,
    title: 'webview',
    style: { border: 0, width: '100%', height: '100%', flex: 1, ...(flat || {}) },
    allow: 'clipboard-read; clipboard-write',
  });
});

export default WebView;
