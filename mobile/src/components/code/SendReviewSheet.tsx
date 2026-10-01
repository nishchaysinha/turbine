import React, { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView } from 'react-native';
import * as Haptics from 'expo-haptics';
import { socketService } from '../../services/socketService';
import { reviewNotes } from '../../services/reviewNotes';
import { formatReviewPrompt, type ReviewNote } from '../../utils/review';
import { codeStyles as c } from './codeStyles';

/**
 * Where review notes go: into a running agent's terminal (as one pasted
 * message), into the focused terminal, or a brand-new agent run.
 */
export const SendReviewSheet: React.FC<{ visible: boolean; notes: ReviewNote[]; onClose: () => void }> = ({
  visible,
  notes,
  onClose,
}) => {
  const [agents, setAgents] = useState(socketService.swarmAgents);
  const [presets, setPresets] = useState(socketService.presets);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(
    () =>
      socketService.subscribe(() => {
        setAgents(socketService.swarmAgents);
        setPresets(socketService.presets);
      }),
    []
  );

  const prompt = useMemo(() => formatReviewPrompt(notes), [notes]);
  const running = agents.filter((a) => a.status === 'running');
  const focusedPane = socketService.focusedPaneId;
  const focusedTitle = socketService.workspaces
    .flatMap((w) => w.panes)
    .find((p) => p.id === focusedPane);

  const done = (message: string) => {
    reviewNotes.clear();
    socketService.lastCommandError = null;
    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {}
    socketService.log(message);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={c.sheetOverlay}>
        <View style={c.sheet}>
          <Text style={c.sheetTitle}>
            Send {notes.length} {notes.length === 1 ? 'note' : 'notes'}
          </Text>
          <Text style={c.sheetSub}>The notes are sent as a single review prompt.</Text>

          {running.length > 0 && <Text style={c.sheetSection}>Running agents</Text>}
          {running.map((agent) => (
            <TouchableOpacity
              key={agent.id}
              style={c.sheetOption}
              onPress={() => {
                socketService.sendPromptToPane(agent.pane_id, prompt);
                done(`Sent review to ${agent.role}`);
              }}
              accessibilityLabel={`Send review to ${agent.role}`}
            >
              <Text style={c.sheetOptionTitle}>🤖 {agent.role}</Text>
              <Text style={c.sheetOptionSub}>Paste into the running agent's terminal</Text>
            </TouchableOpacity>
          ))}

          <Text style={c.sheetSection}>New agent run</Text>
          <View style={c.presetWrap}>
            {(presets.length ? presets : [{ id: '', name: 'Default agent', role: '' }]).map((p) => (
              <TouchableOpacity
                key={p.id || 'default'}
                style={c.sheetChip}
                onPress={() => {
                  socketService.triggerSwarm(prompt, p.id || undefined);
                  done(`Started ${p.name} with review`);
                }}
                accessibilityLabel={`Start ${p.name} with review`}
              >
                <Text style={c.sheetChipText}>＋ {p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {focusedPane && (
            <TouchableOpacity
              style={c.sheetOption}
              onPress={() => {
                socketService.sendPromptToPane(focusedPane, prompt);
                done('Sent review to focused terminal');
              }}
            >
              <Text style={c.sheetOptionTitle}>⌨ {focusedTitle?.title || focusedTitle?.label || 'Focused terminal'}</Text>
              <Text style={c.sheetOptionSub}>Paste into the terminal you last opened</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={() => setShowPrompt((v) => !v)}>
            <Text style={c.sheetLink}>{showPrompt ? '▾' : '▸'} Preview prompt</Text>
          </TouchableOpacity>
          {showPrompt && (
            <ScrollView style={c.promptPreview}>
              <Text style={c.snippetText}>{prompt}</Text>
            </ScrollView>
          )}

          <View style={c.sheetActions}>
            <TouchableOpacity
              style={c.sheetDanger}
              onPress={() => {
                reviewNotes.clear();
                onClose();
              }}
            >
              <Text style={c.sheetDangerText}>Discard notes</Text>
            </TouchableOpacity>
            <TouchableOpacity style={c.sheetCancel} onPress={onClose}>
              <Text style={c.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};
