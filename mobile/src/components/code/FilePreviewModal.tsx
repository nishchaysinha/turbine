import React, { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, FlatList, ScrollView, SafeAreaView } from 'react-native';
import { socketService, type FilePreview } from '../../services/socketService';
import { CommentSheet, type CommentTarget } from './CommentSheet';
import { codeStyles as c } from './codeStyles';

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Read-only source preview with line numbers; tap a line to leave a review note on it. */
export const FilePreviewModal: React.FC = () => {
  const [preview, setPreview] = useState<FilePreview | null>(socketService.filePreview);
  const [target, setTarget] = useState<CommentTarget | null>(null);

  useEffect(() => socketService.subscribe(() => setPreview(socketService.filePreview)), []);

  const lines = useMemo(() => (preview?.content ? preview.content.split('\n') : []), [preview?.content]);
  const close = () => socketService.closeFilePreview();

  return (
    <Modal visible={preview !== null} animationType="slide" onRequestClose={close}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#050c16' }}>
        <View style={c.previewHeader}>
          <Text style={c.previewPath} numberOfLines={2}>
            {preview?.path}
          </Text>
          <TouchableOpacity
            style={c.iconBtn}
            onPress={() => preview && setTarget({ filePath: preview.path, lineNumber: 0, side: 'new', lineText: '' })}
            accessibilityLabel="Comment on file"
          >
            <Text style={c.iconText}>💬</Text>
          </TouchableOpacity>
          <TouchableOpacity style={c.iconBtn} onPress={close} accessibilityLabel="Close preview">
            <Text style={c.iconText}>✕</Text>
          </TouchableOpacity>
        </View>
        <Text style={c.previewMeta}>
          {preview?.loading
            ? 'Loading…'
            : preview?.error
              ? `⚠️ ${preview.error}`
              : preview?.binary
                ? `Binary file · ${formatSize(preview.totalSize)}`
                : `${lines.length} lines · ${formatSize(preview?.totalSize)}${preview?.truncated ? ' · showing first 200 KB' : ''} · tap a line to comment`}
        </Text>
        <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ minWidth: '100%' }}>
          <FlatList
            data={lines}
            keyExtractor={(_, i) => String(i)}
            initialNumToRender={80}
            windowSize={15}
            renderItem={({ item, index }) => (
              <TouchableOpacity
                style={c.previewLine}
                activeOpacity={0.6}
                onPress={() => preview && setTarget({ filePath: preview.path, lineNumber: index + 1, side: 'new', lineText: item })}
              >
                <Text style={c.previewNo}>{index + 1}</Text>
                <Text style={c.previewCode}>{item || ' '}</Text>
              </TouchableOpacity>
            )}
          />
        </ScrollView>
        <CommentSheet target={target} onClose={() => setTarget(null)} />
      </SafeAreaView>
    </Modal>
  );
};
