import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  TextInput,
  Platform,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { PaneConfig } from '../types';
import { VirtualKeyboard } from './VirtualKeyboard';
import { TERMINAL_HTML } from './terminalHtml';
import { ctrlChord } from '../utils/keys';
import { socketService } from '../services/socketService';
import * as Haptics from 'expo-haptics';

interface FocusedTerminalViewProps {
  pane: PaneConfig;
  allPanes: PaneConfig[];
  onUnfocus: () => void;
  onSwitchPane: (paneId: string) => void;
}

type ScaleMode = 'fit-screen' | 'fit-width' | '100' | 'custom';

export const FocusedTerminalView: React.FC<FocusedTerminalViewProps> = ({
  pane,
  allPanes,
  onUnfocus,
  onSwitchPane,
}) => {
  const webViewRef = useRef<WebView>(null);
  const [showPanePicker, setShowPanePicker] = useState(false);
  const [scaleMode, setScaleMode] = useState<ScaleMode>('fit-width');
  const [scalePercent, setScalePercent] = useState<number>(100);
  const [ctrlActive, setCtrlActive] = useState(false);
  // Orca-style input modes: type straight into the PTY, or compose a full line first.
  const [composeMode, setComposeMode] = useState(false);
  const [draft, setDraft] = useState('');
  const historyRef = useRef<string[]>([]);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrlActive;
  const scaleModeRef = useRef<ScaleMode>(scaleMode);
  scaleModeRef.current = scaleMode;
  const readyRef = useRef(false);

  const inject = useCallback((js: string) => {
    if (readyRef.current) webViewRef.current?.injectJavaScript(js);
  }, []);
  const [dimensions, setDimensions] = useState(
    socketService.getPaneDimensions(pane.id) || { cols: 80, rows: 24 }
  );

  // Send terminal sync request when switching pane
  useEffect(() => {
    socketService.requestTerminalSync(pane.id);
    const existingDims = socketService.getPaneDimensions(pane.id);
    if (existingDims) {
      setDimensions(existingDims);
    }
  }, [pane.id]);

  // Subscribe to raw terminal stream events
  useEffect(() => {
    const unsubOutput = socketService.onTerminalOutput((paneId, data) => {
      if (paneId === pane.id) {
        inject(`window.writeOutput && window.writeOutput(${JSON.stringify(data)}); true;`);
      }
    });

    const unsubResize = socketService.onTerminalResize((paneId, cols, rows) => {
      if (paneId === pane.id) {
        setDimensions({ cols, rows });
        inject(`window.resizeTerminal && window.resizeTerminal(${cols}, ${rows}); true;`);
      }
    });

    const unsubSync = socketService.onTerminalSync((paneId, cols, rows, buffer) => {
      if (paneId === pane.id) {
        setDimensions({ cols, rows });
        inject(`window.syncTerminal && window.syncTerminal(${cols}, ${rows}, ${JSON.stringify(buffer)}); true;`);
      }
    });

    return () => {
      unsubOutput();
      unsubResize();
      unsubSync();
    };
  }, [pane.id, inject]);

  // Switching panes reuses the same WebView: repaint it from the replay buffer.
  useEffect(() => {
    const dims = socketService.getPaneDimensions(pane.id) || { cols: 80, rows: 24 };
    inject(
      `window.syncTerminal && window.syncTerminal(${dims.cols}, ${dims.rows}, ${JSON.stringify(socketService.getPaneOutput(pane.id))}); true;`
    );
  }, [pane.id, inject]);

  const sendInput = useCallback((data: string) => {
    if (ctrlRef.current) {
      const chord = ctrlChord(data);
      setCtrlActive(false);
      if (chord !== null) {
        socketService.sendTerminalInput(pane.id, chord);
        return;
      }
    }
    socketService.sendTerminalInput(pane.id, data);
  }, [pane.id]);

  const handleMessage = useCallback((event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'input') {
        // Direct keystroke from terminal emulator -> send to desktop PTY
        sendInput(msg.data);
      } else if (msg.type === 'scale_change') {
        setScalePercent(Math.round(msg.scale * 100));
        if (msg.cols && msg.rows) {
          setDimensions({ cols: msg.cols, rows: msg.rows });
        }
      } else if (msg.type === 'ready') {
        // WebView xterm is ready: apply scale mode and populate with the replay buffer
        readyRef.current = true;
        const dims = socketService.getPaneDimensions(pane.id) || { cols: 80, rows: 24 };
        const buffer = socketService.getPaneOutput(pane.id);
        inject(`window.setScaleMode && window.setScaleMode('${scaleModeRef.current}'); true;`);
        inject(`window.syncTerminal && window.syncTerminal(${dims.cols}, ${dims.rows}, ${JSON.stringify(buffer)}); true;`);
      }
    } catch {}
  }, [pane.id, sendInput, inject]);

  const sendDraft = () => {
    const line = draft;
    if (line.trim()) {
      historyRef.current = [line, ...historyRef.current.filter((h) => h !== line)].slice(0, 20);
    }
    socketService.sendTerminalInput(pane.id, `${line}\r`);
    setDraft('');
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
  };

  const changeScaleMode = (mode: ScaleMode) => {
    setScaleMode(mode);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    inject(`window.setScaleMode && window.setScaleMode('${mode}'); true;`);
  };

  const adjustZoom = (delta: number) => {
    setScaleMode('custom');
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    inject(`window.adjustZoom && window.adjustZoom(${delta}); true;`);
  };

  const focusTerminal = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    inject(`window.focusTerminal && window.focusTerminal(); true;`);
  };



  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 70 : 0}
    >
      {/* Header Bar */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.unfocusBtn} onPress={onUnfocus} activeOpacity={0.7}>
          <Text style={styles.unfocusArrow}>←</Text>
          <Text style={styles.unfocusText}>Tiled Layout</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.paneTitleSelector}
          onPress={() => setShowPanePicker(!showPanePicker)}
          activeOpacity={0.7}
        >
          <View style={styles.statusDot} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {pane.title || pane.label || pane.type}
          </Text>
          <Text style={styles.dimsText}>
            ({dimensions.cols}×{dimensions.rows})
          </Text>
          <Text style={styles.dropdownIcon}>▾</Text>
        </TouchableOpacity>
      </View>

      {/* Switcher Dropdown (if toggled) */}
      {showPanePicker && (
        <View style={styles.pickerDropdown}>
          <Text style={styles.pickerLabel}>Switch Active Terminal:</Text>
          {allPanes.map((p) => (
            <TouchableOpacity
              key={p.id}
              style={[styles.pickerItem, p.id === pane.id && styles.pickerItemActive]}
              onPress={() => {
                onSwitchPane(p.id);
                setShowPanePicker(false);
              }}
            >
              <Text style={[styles.pickerItemText, p.id === pane.id && styles.pickerItemTextActive]}>
                {p.title || p.label || p.type}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Stream Scaler & Zoom Toolbar (shellf-driving inspired) */}
      <View style={styles.scalerToolbar}>
        <View style={styles.modeButtons}>
          <TouchableOpacity
            style={[styles.modeBtn, scaleMode === 'fit-width' && styles.modeBtnActive]}
            onPress={() => changeScaleMode('fit-width')}
          >
            <Text style={[styles.modeBtnText, scaleMode === 'fit-width' && styles.modeBtnTextActive]}>
              Width
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeBtn, scaleMode === 'fit-screen' && styles.modeBtnActive]}
            onPress={() => changeScaleMode('fit-screen')}
          >
            <Text style={[styles.modeBtnText, scaleMode === 'fit-screen' && styles.modeBtnTextActive]}>
              Screen
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeBtn, scaleMode === '100' && styles.modeBtnActive]}
            onPress={() => changeScaleMode('100')}
          >
            <Text style={[styles.modeBtnText, scaleMode === '100' && styles.modeBtnTextActive]}>
              1:1
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.zoomControls}>
          <TouchableOpacity style={styles.zoomBtn} onPress={() => adjustZoom(-0.1)}>
            <Text style={styles.zoomBtnText}>−</Text>
          </TouchableOpacity>

          <View style={styles.percentBadge}>
            <Text style={styles.percentText}>{scalePercent}%</Text>
          </View>

          <TouchableOpacity style={styles.zoomBtn} onPress={() => adjustZoom(0.1)}>
            <Text style={styles.zoomBtnText}>+</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.keyboardFocusBtn, composeMode && styles.composeBtnActive]}
            onPress={() => setComposeMode((v) => !v)}
            accessibilityLabel="Toggle compose mode"
          >
            <Text style={[styles.keyboardFocusText, composeMode && styles.composeTextActive]}>✎</Text>
          </TouchableOpacity>

          {!composeMode && (
            <TouchableOpacity style={styles.keyboardFocusBtn} onPress={focusTerminal} accessibilityLabel="Type">
              <Text style={styles.keyboardFocusText}>⌨</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* 1:1 Scaled Hardware-Accelerated Terminal Viewport */}
      <View style={styles.terminalContainer}>
        <WebView
          ref={webViewRef}
          originWhitelist={['*']}
          source={{ html: TERMINAL_HTML, baseUrl: 'https://localhost' }}
          onContentProcessDidTerminate={() => {
            readyRef.current = false;
            webViewRef.current?.reload();
          }}
          style={styles.webView}
          onMessage={handleMessage}
          scrollEnabled={true}
          bounces={false}
          keyboardDisplayRequiresUserAction={false}
          automaticallyAdjustContentInsets={false}
          hideKeyboardAccessoryView={true}
        />
      </View>

      {composeMode && (
        <View style={styles.composeBar}>
          {historyRef.current.length > 0 && !draft && (
            <TouchableOpacity style={styles.historyBtn} onPress={() => setDraft(historyRef.current[0])}>
              <Text style={styles.historyText}>↑</Text>
            </TouchableOpacity>
          )}
          <TextInput
            style={styles.composeInput}
            value={draft}
            onChangeText={setDraft}
            placeholder="Type a command or prompt, then Send"
            placeholderTextColor="#4a657e"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={sendDraft}
            multiline={false}
          />
          <TouchableOpacity style={styles.sendBtn} onPress={sendDraft} accessibilityLabel="Send">
            <Text style={styles.sendText}>Send</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Native Mobile Virtual Keyboard Toolbar (Pinned directly above iOS keyboard) */}
      <VirtualKeyboard
        onKey={sendInput}
        ctrlActive={ctrlActive}
        onToggleCtrl={() => setCtrlActive((v) => !v)}
        onClear={() => {
          socketService.clearPaneOutput(pane.id);
          inject(`window.clearTerminal && window.clearTerminal(); true;`);
        }}
      />
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  composeBtnActive: {
    backgroundColor: '#00e5c8',
  },
  composeTextActive: {
    color: '#05111c',
  },
  composeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#081422',
    borderTopWidth: 1,
    borderTopColor: '#13283c',
  },
  composeInput: {
    flex: 1,
    backgroundColor: '#050c16',
    borderWidth: 1,
    borderColor: '#193959',
    borderRadius: 8,
    color: '#d6e6f5',
    fontFamily: 'Courier',
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sendBtn: {
    backgroundColor: '#00e5c8',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  sendText: {
    color: '#05111c',
    fontWeight: '700',
    fontSize: 13,
  },
  historyBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#193959',
  },
  historyText: {
    color: '#00e5c8',
    fontWeight: '700',
  },
  container: {
    flex: 1,
    backgroundColor: '#050c16',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#091829',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#173654',
  },
  unfocusBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0, 229, 200, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(0, 229, 200, 0.4)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  unfocusArrow: {
    color: '#00e5c8',
    fontSize: 14,
    fontWeight: '700',
  },
  unfocusText: {
    color: '#00e5c8',
    fontSize: 12,
    fontWeight: '600',
  },
  paneTitleSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0c2238',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    maxWidth: 220,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#00e5c8',
  },
  headerTitle: {
    color: '#d6e6f5',
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  dimsText: {
    color: '#7b98b3',
    fontSize: 10,
    fontWeight: '500',
  },
  dropdownIcon: {
    color: '#7b98b3',
    fontSize: 10,
  },
  pickerDropdown: {
    backgroundColor: '#0c2238',
    borderBottomWidth: 1,
    borderBottomColor: '#1a4168',
    padding: 10,
  },
  pickerLabel: {
    color: '#7f9db8',
    fontSize: 11,
    marginBottom: 6,
    fontWeight: '500',
  },
  pickerItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 4,
    marginBottom: 2,
  },
  pickerItemActive: {
    backgroundColor: 'rgba(0, 229, 200, 0.15)',
  },
  pickerItemText: {
    color: '#b0c7db',
    fontSize: 12,
  },
  pickerItemTextActive: {
    color: '#00e5c8',
    fontWeight: '600',
  },
  scalerToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#081422',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#13283c',
  },
  modeButtons: {
    flexDirection: 'row',
    gap: 4,
  },
  modeBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    backgroundColor: '#0e2338',
    borderWidth: 1,
    borderColor: '#193959',
  },
  modeBtnActive: {
    backgroundColor: '#00e5c8',
    borderColor: '#00e5c8',
  },
  modeBtnText: {
    color: '#9cb5cc',
    fontSize: 11,
    fontWeight: '600',
  },
  modeBtnTextActive: {
    color: '#05111c',
    fontWeight: '700',
  },
  zoomControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  zoomBtn: {
    width: 24,
    height: 24,
    borderRadius: 4,
    backgroundColor: '#0e2338',
    borderWidth: 1,
    borderColor: '#193959',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomBtnText: {
    color: '#00e5c8',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 16,
  },
  percentBadge: {
    minWidth: 36,
    alignItems: 'center',
  },
  percentText: {
    color: '#90acc4',
    fontSize: 11,
    fontWeight: '600',
  },
  keyboardFocusBtn: {
    backgroundColor: 'rgba(0, 229, 200, 0.15)',
    borderWidth: 1,
    borderColor: '#00e5c8',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    marginLeft: 4,
  },
  keyboardFocusText: {
    color: '#00e5c8',
    fontSize: 11,
    fontWeight: '700',
  },
  terminalContainer: {
    flex: 1,
    backgroundColor: '#070d14',
  },
  webView: {
    flex: 1,
    backgroundColor: '#070d14',
  },
});
