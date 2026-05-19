import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import {
  Alert,
  Button,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { db } from './firebaseConfig';
import {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
} from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';
import NetInfo from '@react-native-community/netinfo';

// ==================== CONSTANTES ====================
const USINAS = ['GD-1', 'GD-2', 'GD-3', 'GD-4', 'PARAOPEBA-1', 'PARAOPEBA-2'];
const SUBAREAS: Record<string, string[]> = {
  'GD-1': ['UFV 1', 'UFV 2', 'UFV 3'],
  'GD-2': ['UFV 1', 'UFV 2', 'UFV 3'],
  'GD-3': ['UFV 1', 'UFV 2', 'UFV 3'],
  'GD-4': ['UFV 1', 'UFV 2', 'UFV 3'],
  'PARAOPEBA-1': ['A', 'B', 'C'],
  'PARAOPEBA-2': ['A', 'B', 'C'],
};

// ==================== TIPAGENS ====================
type DamagedModule = {
  id?: string;
  code: string;
  usina: string;
  subarea: string;
  timestamp: string;
  pending?: boolean;
};

type DamagedContextType = {
  modules: DamagedModule[];
  codesSet: Set<string>;
  loading: boolean;
  syncError: string | null;
  retryInitialLoad: () => void;
  addModule: (usina: string, sub: string, code: string) => Promise<boolean>;
};

const DamagedContext = createContext<DamagedContextType>({
  modules: [],
  codesSet: new Set(),
  loading: true,
  syncError: null,
  retryInitialLoad: () => {},
  addModule: async () => false,
});

const useDamaged = () => useContext(DamagedContext);

// ==================== PROVIDER ====================
function DamagedProvider({ children }: { children: React.ReactNode }) {
  const [modules, setModules] = useState<DamagedModule[]>([]);
  const [codesSet, setCodesSet] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pendingQueue, setPendingQueue] = useState<DamagedModule[]>([]);
  const [isOnline, setIsOnline] = useState(false);
  const isSyncing = useRef(false);

  // ---- Persistência ----
  const loadPendingFromStorage = async (): Promise<DamagedModule[]> => {
    const raw = await AsyncStorage.getItem('@pending_damaged');
    return raw ? JSON.parse(raw) : [];
  };

  const savePendingToStorage = async (queue: DamagedModule[]) => {
    await AsyncStorage.setItem('@pending_damaged', JSON.stringify(queue));
  };

  // ---- Sincronizar pendentes ----
  const syncPending = useCallback(async (queue: DamagedModule[]) => {
    if (!isOnline || queue.length === 0 || isSyncing.current) return;
    isSyncing.current = true;

    const remaining: DamagedModule[] = [];

    for (const mod of queue) {
      try {
        const docRef = await addDoc(collection(db, 'ModulosDanificados'), {
          code: mod.code,
          usina: mod.usina,
          subarea: mod.subarea,
          timestamp: mod.timestamp,
        });

        setModules((prev) =>
          prev.map((m) =>
            m.code === mod.code && m.pending
              ? { ...m, id: docRef.id, pending: false }
              : m
          )
        );
      } catch (error) {
        console.error('Erro ao sincronizar:', mod.code, error);
        remaining.push(mod);
      }
    }

    await savePendingToStorage(remaining);
    setPendingQueue(remaining);
    isSyncing.current = false;
  }, [isOnline]);

  // ---- Listener único do Firestore ----
  const startListener = () => {
    setLoading(true);
    setSyncError(null);

    const q = query(
      collection(db, 'ModulosDanificados'),
      orderBy('timestamp', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const freshModules: DamagedModule[] = [];
      const freshCodes = new Set<string>();
      snapshot.forEach((doc) => {
        const data = doc.data();
        freshModules.push({
          id: doc.id,
          code: data.code,
          usina: data.usina,
          subarea: data.subarea,
          timestamp: data.timestamp,
          pending: false,
        });
        freshCodes.add(data.code);
      });

      setModules((prev) => {
        const stillPending = prev.filter(
          (m) => m.pending && !freshCodes.has(m.code)
        );
        const merged = [...stillPending, ...freshModules];
        merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return merged;
      });

      setCodesSet((prev) => {
        const combined = new Set(prev);
        freshCodes.forEach((c) => combined.add(c));
        return combined;
      });

      setLoading(false);
      setSyncError(null);
    }, (error) => {
      console.error('Erro no listener:', error);
      setSyncError('Falha ao carregar dados do servidor.');
      setLoading(false);
    });

    return unsubscribe;
  };

  const listenerUnsubscribe = useRef<(() => void) | null>(null);

  const retryInitialLoad = () => {
    if (listenerUnsubscribe.current) {
      listenerUnsubscribe.current();
    }
    listenerUnsubscribe.current = startListener();
  };

  // ---- Adicionar módulo (offline-first) ----
  const addModule = useCallback(async (usina: string, sub: string, code: string): Promise<boolean> => {
    if (codesSet.has(code)) return false;

    const now = new Date();
    const timestamp = formatDateTime(now);
    const newMod: DamagedModule = {
      code,
      usina,
      subarea: sub,
      timestamp,
      pending: true,
    };

    const updatedModules = [...modules, newMod].sort(
      (a, b) => b.timestamp.localeCompare(a.timestamp)
    );
    setModules(updatedModules);
    const newCodes = new Set(codesSet);
    newCodes.add(code);
    setCodesSet(newCodes);

    const updatedQueue = [...pendingQueue, newMod];
    await savePendingToStorage(updatedQueue);
    setPendingQueue(updatedQueue);

    if (isOnline) {
      syncPending(updatedQueue);
    }

    return true;
  }, [modules, codesSet, pendingQueue, isOnline, syncPending]);

  // ---- Monitoramento de conexão ----
  useEffect(() => {
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      const online = !!(state.isConnected && state.isInternetReachable);
      setIsOnline(online);
      if (online) {
        syncPending(pendingQueue);
      }
    });
    return () => unsubscribeNet();
  }, [pendingQueue, syncPending]);

  // ---- Inicialização ----
  useEffect(() => {
    const init = async () => {
      const storedPending = await loadPendingFromStorage();
      setPendingQueue(storedPending);
      if (storedPending.length > 0) {
        setModules((prev) => {
          const merged = [...prev, ...storedPending];
          merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
          return merged;
        });
        const codes = new Set(storedPending.map((m) => m.code));
        setCodesSet((prev) => new Set([...prev, ...codes]));
      }
    };
    init();
    listenerUnsubscribe.current = startListener();
    return () => {
      if (listenerUnsubscribe.current) {
        listenerUnsubscribe.current();
      }
    };
  }, []);

  return (
    <DamagedContext.Provider
      value={{
        modules,
        codesSet,
        loading,
        syncError,
        retryInitialLoad,
        addModule,
      }}
    >
      {children}
    </DamagedContext.Provider>
  );
}

// ==================== FORMATADOR DE DATA ====================
const formatDateTime = (date: Date): string => {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return formatter.format(date);
};

// ==================== TELA REGISTRAR ====================
function RegistrarScreen() {
  const { modules, codesSet, loading, syncError, addModule } = useDamaged();
  const [selectedUsina, setSelectedUsina] = useState('');
  const [selectedSub, setSelectedSub] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const filteredModules = modules.filter(
    (m) => m.usina === selectedUsina && m.subarea === selectedSub
  );

  const handleAdd = async () => {
    const trimmed = codeInput.trim();
    if (!trimmed) {
      Alert.alert('Código vazio', 'Digite um código de 14 dígitos.');
      inputRef.current?.focus();
      return;
    }
    if (trimmed.length !== 14) {
      Alert.alert('Tamanho inválido', '14 números exigidos.');
      setCodeInput('');
      inputRef.current?.focus();
      return;
    }
    if (!selectedUsina || !selectedSub) {
      Alert.alert('Seleção incompleta', 'Escolha usina e subárea.');
      return;
    }

    setSaving(true);
    const success = await addModule(selectedUsina, selectedSub, trimmed);
    if (!success) {
      Alert.alert('Código já registrado', 'Este código já existe nos módulos danificados.');
    }
    setCodeInput('');
    inputRef.current?.focus();
    setSaving(false);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1976d2" />
        <Text>Carregando dados...</Text>
      </View>
    );
  }

  if (syncError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{syncError}</Text>
        <Button title="Tentar novamente" onPress={() => useDamaged().retryInitialLoad()} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Módulos Danificados</Text>

      <Text style={styles.label}>Usina:</Text>
      <View style={styles.pickerContainer}>
        <Picker
          selectedValue={selectedUsina}
          onValueChange={(value) => {
            setSelectedUsina(value);
            setSelectedSub('');
          }}
        >
          <Picker.Item label="Selecione..." value="" />
          {USINAS.map((u) => (
            <Picker.Item key={u} label={u} value={u} />
          ))}
        </Picker>
      </View>

      {selectedUsina !== '' && (
        <>
          <Text style={styles.label}>Subárea:</Text>
          <View style={styles.pickerContainer}>
            <Picker
              selectedValue={selectedSub}
              onValueChange={setSelectedSub}
            >
              <Picker.Item label="Selecione..." value="" />
              {SUBAREAS[selectedUsina]?.map((sub) => (
                <Picker.Item key={sub} label={sub} value={sub} />
              ))}
            </Picker>
          </View>
        </>
      )}

      {selectedUsina !== '' && selectedSub !== '' && (
        <>
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.codeInput}
              placeholder="Código (14 números)"
              keyboardType="numeric"
              maxLength={14}
              value={codeInput}
              onChangeText={(text) => setCodeInput(text.replace(/[^0-9]/g, ''))}
              onSubmitEditing={handleAdd}
            />
            <Button title="Adicionar" onPress={handleAdd} disabled={saving} />
          </View>
          {saving && (
            <ActivityIndicator size="small" color="#1976d2" style={{ marginBottom: 8 }} />
          )}
        </>
      )}

      {selectedUsina !== '' && selectedSub !== '' && (
        <>
          <Text style={styles.listTitle}>
            Módulos registrados ({filteredModules.length})
          </Text>
          <FlatList
            data={filteredModules}
            keyExtractor={(item, index) => item.id || index.toString()}
            renderItem={({ item }) => (
              <View style={[styles.moduleRow, item.pending && styles.pendingRow]}>
                <Text style={styles.moduleCode}>{item.code}</Text>
                <Text style={styles.moduleDate}>{item.timestamp}</Text>
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyText}>Nenhum módulo registrado.</Text>
            }
          />
        </>
      )}
    </View>
  );
}

// ==================== TELA TODOS ====================
function TodosScreen() {
  const { modules, loading, syncError, retryInitialLoad } = useDamaged();
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedModules, setSelectedModules] = useState<DamagedModule[]>([]);
  const [selectedTitle, setSelectedTitle] = useState('');

  // Agrupa módulos por usina e depois por subarea
  const groupedByUsina: Record<string, Record<string, DamagedModule[]>> = {};
  modules.forEach((mod) => {
    if (!groupedByUsina[mod.usina]) groupedByUsina[mod.usina] = {};
    if (!groupedByUsina[mod.usina][mod.subarea]) groupedByUsina[mod.usina][mod.subarea] = [];
    groupedByUsina[mod.usina][mod.subarea].push(mod);
  });

  // Transforma em estrutura para renderização: lista de usinas, cada uma com lista de subareas
  const usinaCards = Object.entries(groupedByUsina).map(([usina, subareas]) => ({
    usina,
    subareas: Object.entries(subareas).map(([subarea, mods]) => ({
      title: `${usina} - ${subarea}`,
      modules: mods,
    })),
  }));

  const openDetails = (title: string, mods: DamagedModule[]) => {
    setSelectedTitle(title);
    setSelectedModules(mods);
    setModalVisible(true);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1976d2" />
        <Text>Carregando todos os módulos...</Text>
      </View>
    );
  }

  if (syncError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{syncError}</Text>
        <Button title="Tentar novamente" onPress={retryInitialLoad} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Todos os Módulos Danificados</Text>
      <FlatList
        data={usinaCards}
        keyExtractor={(item) => item.usina}
        renderItem={({ item: usinaItem }) => (
          <View style={styles.usinaSection}>
            <Text style={styles.usinaSectionTitle}>{usinaItem.usina}</Text>
            {usinaItem.subareas.map((subareaItem) => (
              <View key={subareaItem.title} style={styles.card}>
                <Text style={styles.cardTitle}>{subareaItem.title}</Text>
                <Text style={styles.cardSubtitle}>
                  {subareaItem.modules.length} módulo(s)
                </Text>
                <Button
                  title="Detalhes"
                  onPress={() => openDetails(subareaItem.title, subareaItem.modules)}
                />
              </View>
            ))}
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.emptyText}>Nenhum módulo registrado.</Text>
        }
      />

      {/* Modal de detalhes da subárea */}
      <Modal visible={modalVisible} animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalContainer}>
          <Text style={styles.modalTitle}>{selectedTitle}</Text>
          <FlatList
            data={selectedModules}
            keyExtractor={(item, index) => item.id || index.toString()}
            renderItem={({ item }) => (
              <View style={[styles.moduleRow, item.pending && styles.pendingRow]}>
                <Text style={styles.moduleCode}>{item.code}</Text>
                <Text style={styles.moduleDate}>{item.timestamp}</Text>
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyText}>Nenhum módulo.</Text>
            }
          />
          <Button title="Fechar" onPress={() => setModalVisible(false)} />
        </View>
      </Modal>
    </View>
  );
}

// ==================== NAVEGAÇÃO ====================
const Tab = createBottomTabNavigator();

export default function App() {
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const auth = getAuth();
    signInAnonymously(auth)
      .then(() => {
        console.log('Autenticado anonimamente.');
        setAuthReady(true);
      })
      .catch((error) => {
        console.error('Erro na autenticação:', error);
        Alert.alert('Erro', 'Não foi possível conectar ao servidor.');
      });
  }, []);

  if (!authReady) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1976d2" />
        <Text>Conectando ao servidor...</Text>
      </View>
    );
  }

  return (
    <DamagedProvider>
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            tabBarLabelStyle: { fontSize: 14, fontWeight: 'bold' },
            headerShown: false,
            tabBarStyle: { height: 100 },
          }}
        >
          <Tab.Screen name="Registrar" component={RegistrarScreen} />
          <Tab.Screen name="Todos" component={TodosScreen} />
        </Tab.Navigator>
      </NavigationContainer>
    </DamagedProvider>
  );
}

// ==================== ESTILOS ====================
const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#f5f5f5' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  title: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 16, color: '#1976d2' },
  label: { fontSize: 16, fontWeight: 'bold', marginTop: 8, marginBottom: 4 },
  pickerContainer: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    backgroundColor: '#fff',
    marginBottom: 12,
  },
  inputRow: {
    flexDirection: 'row',
    marginBottom: 16,
    gap: 8,
  },
  codeInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 8,
    backgroundColor: '#fff',
  },
  listTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 8,
    marginBottom: 8,
  },
  moduleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 8,
    marginBottom: 6,
    elevation: 1,
  },
  pendingRow: {
    backgroundColor: '#fff9c4',
  },
  moduleCode: { fontSize: 16, fontWeight: 'bold' },
  moduleDate: { fontSize: 14, color: '#555' },
  emptyText: { textAlign: 'center', marginTop: 20, color: '#888' },
  errorText: { fontSize: 18, color: '#d32f2f', textAlign: 'center', marginBottom: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    elevation: 3,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1976d2',
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 14,
    color: '#555',
    marginBottom: 8,
  },
  modalContainer: { flex: 1, padding: 20, backgroundColor: '#fff' },
  modalTitle: { fontSize: 22, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
    usinaSection: {
    marginBottom: 20,
  },
  usinaSectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1976d2',
    marginBottom: 8,
    paddingLeft: 4,
  },
});