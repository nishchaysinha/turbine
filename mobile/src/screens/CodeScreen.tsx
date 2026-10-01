import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ReviewView } from '../components/code/ReviewView';
import { FileExplorerView } from '../components/code/FileExplorerView';
import { reviewNotes } from '../services/reviewNotes';

type Segment = 'changes' | 'files';

/** Code tab: review uncommitted changes (with notes for agents) or browse the project. */
export const CodeScreen: React.FC = () => {
  const [segment, setSegment] = useState<Segment>('changes');
  const [noteCount, setNoteCount] = useState(reviewNotes.get().length);

  useEffect(() => reviewNotes.subscribe((n) => setNoteCount(n.length)), []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Code</Text>
        <View style={styles.segments}>
          {(['changes', 'files'] as const).map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.segment, segment === s && styles.segmentActive]}
              onPress={() => setSegment(s)}
            >
              <Text style={[styles.segmentText, segment === s && styles.segmentTextActive]}>
                {s === 'changes' ? `Changes${noteCount ? ` · ${noteCount}💬` : ''}` : 'Files'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      {segment === 'changes' ? <ReviewView /> : <FileExplorerView />}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050c16' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#091829',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#173654',
  },
  title: { color: '#00e5c8', fontSize: 16, fontWeight: '700' },
  segments: { flexDirection: 'row', backgroundColor: '#050c16', borderRadius: 8, padding: 2 },
  segment: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  segmentActive: { backgroundColor: '#00e5c8' },
  segmentText: { color: '#9cb5cc', fontSize: 12, fontWeight: '600' },
  segmentTextActive: { color: '#05111c', fontWeight: '800' },
});
