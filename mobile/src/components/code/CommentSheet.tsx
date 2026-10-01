import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { reviewNotes } from '../../services/reviewNotes';
import type { ReviewNote } from '../../utils/review';
import { codeStyles as c } from './codeStyles';

export interface CommentTarget {
  filePath: string;
  lineNumber: number;
  side: 'new' | 'old';
  lineText: string;
  /** Present when editing an existing note. */
  note?: ReviewNote;
}

export const CommentSheet: React.FC<{ target: CommentTarget | null; onClose: () => void }> = ({ target, onClose }) => {
  const [body, setBody] = useState('');

  useEffect(() => {
    setBody(target?.note?.body ?? '');
  }, [target]);

  const save = () => {
    if (!target) return;
    if (target.note) reviewNotes.update(target.note.id, body);
    else reviewNotes.add({ filePath: target.filePath, lineNumber: target.lineNumber, side: target.side, lineText: target.lineText, body });
    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {}
    onClose();
  };

  const location = target
    ? target.lineNumber === 0
      ? target.filePath
      : `${target.filePath}:${target.lineNumber}${target.side === 'old' ? ' (removed)' : ''}`
    : '';

  return (
    <Modal visible={target !== null} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={c.sheetOverlay}>
        <View style={c.sheet}>
          <Text style={c.sheetTitle}>{target?.note ? 'Edit note' : 'Add review note'}</Text>
          <Text style={c.sheetSub} numberOfLines={1}>
            {location}
          </Text>
          {target?.lineText ? (
            <View style={c.snippet}>
              <Text style={c.snippetText} numberOfLines={3}>
                {target.lineText}
              </Text>
            </View>
          ) : null}
          <TextInput
            style={c.sheetInput}
            value={body}
            onChangeText={setBody}
            placeholder="What should change here?"
            placeholderTextColor="#5a7690"
            multiline
            autoFocus
          />
          <View style={c.sheetActions}>
            {target?.note ? (
              <TouchableOpacity
                style={c.sheetDanger}
                onPress={() => {
                  reviewNotes.remove(target.note!.id);
                  onClose();
                }}
              >
                <Text style={c.sheetDangerText}>Delete</Text>
              </TouchableOpacity>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <TouchableOpacity style={c.sheetCancel} onPress={onClose}>
              <Text style={c.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[c.sheetPrimary, !body.trim() && { opacity: 0.5 }]} onPress={save} disabled={!body.trim()}>
              <Text style={c.sheetPrimaryText}>Save note</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};
