import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { socketService } from '../services/socketService';

/** Troubleshooting view of recent connection events (newest first). */
export const ConnectionLog: React.FC<{ limit?: number }> = ({ limit = 40 }) => {
  const [entries, setEntries] = useState(socketService.connectionLog);

  useEffect(() => socketService.subscribe(() => setEntries(socketService.connectionLog)), []);

  if (entries.length === 0) {
    return <Text style={styles.empty}>No connection events yet.</Text>;
  }

  return (
    <View style={styles.list}>
      {entries
        .slice(-limit)
        .reverse()
        .map((e, i) => (
          <Text key={`${e.at}-${i}`} style={styles.line}>
            <Text style={styles.time}>{new Date(e.at).toLocaleTimeString()} </Text>
            {e.message}
          </Text>
        ))}
    </View>
  );
};

const styles = StyleSheet.create({
  list: { gap: 2 },
  line: { color: '#b0c7db', fontSize: 11, fontFamily: 'Courier' },
  time: { color: '#5c768d' },
  empty: { color: '#5c768d', fontSize: 12 },
});
