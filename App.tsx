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
  orderBy,
  onSnapshot,
  getDocs,
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
  isOnline: boolean;
  retryInitialLoad: () => void;
  addModule: (usina: string, sub: string, code: string) => Promise<boolean>;
};

const DamagedContext = createContext<DamagedContextType>({
  modules: [],
  codesSet: new Set(),
  loading: true,
  syncError: null,
  isOnline: false,
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
  const listenerUnsubscribe = useRef<(() => void) | null>(null);

  // ---- Persistência ----
  const loadPendingFromStorage = async (): Promise<DamagedModule[]> => {
    const raw = await AsyncStorage.getItem('@pending_damaged');
    return raw ? JSON.parse(raw) : [];
  };

  const savePendingToStorage = async (queue: DamagedModule[]) => {
    await AsyncStorage.setItem('@pending_damaged', JSON.stringify(queue));
  };

  // ---- Recarregar base do Firestore (usado antes de sincronizar) ----
  const refreshFirestoreData = async (): Promise<{ modules: DamagedModule[]; codes: Set<string> }> => {
    const q = query(collection(db, 'ModulosDanificados'), orderBy('timestamp', 'desc'));
    const snapshot = await getDocs(q);
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
    return { modules: freshModules, codes: freshCodes };
  };

  // ---- Sincronizar pendentes com verificação prévia de duplicidade ----
  const syncPending = useCallback(async (queue: DamagedModule[]) => {
    if (!isOnline || queue.length === 0 || isSyncing.current) return;
    isSyncing.current = true;

    // Antes de enviar, recarrega a base do Firestore para ter os códigos mais recentes
    let freshCodes: Set<string>;
    try {
      const fresh = await refreshFirestoreData();
      freshCodes = fresh.codes;
      // Atualiza o estado local com os dados oficiais, mantendo pendentes ainda não sincronizados
      setModules((prev) => {
        const stillPending = prev.filter(m => m.pending && !freshCodes.has(m.code));
        return [...stillPending, ...fresh.modules].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      });
      setCodesSet((prev) => {
        const combined = new Set(prev);
        freshCodes.forEach(c => combined.add(c));
        return combined;
      });
    } catch (error) {
      console.error('Erro ao recarregar base antes de sincronizar:', error);
      // Se falhar, usa o codesSet atual (melhor que nada)
      freshCodes = new Set(codesSet);
    }

    const remaining: DamagedModule[] = [];

    for (const mod of queue) {
      // Se o código já existe no servidor (recém-baixado), não envia e remove da fila
      if (freshCodes.has(mod.code)) {
        // Remove da lista local (some o amarelo, pois já está no servidor)
        setModules((prev) => prev.filter(m => m.code !== mod.code || !m.pending));
        continue;
      }

      try {
        const docRef = await addDoc(collection(db, 'ModulosDanificados'), {
          code: mod.code,
          usina: mod.usina,
          subarea: mod.subarea,
          timestamp: mod.timestamp,
        });
        // Atualiza o módulo local: deixa de ser pendente
        setModules((prev) =>
          prev.map((m) =>
            m.code === mod.code && m.pending ? { ...m, id: docRef.id, pending: false } : m
          )
        );
        // Adiciona o código ao Set para futuras verificações
        freshCodes.add(mod.code);
      } catch (error) {
        console.error('Erro ao sincronizar:', mod.code, error);
        remaining.push(mod);
      }
    }

    await savePendingToStorage(remaining);
    setPendingQueue(remaining);
    isSyncing.current = false;
  }, [isOnline, codesSet]);

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

    listenerUnsubscribe.current = unsubscribe;
  };

  const retryInitialLoad = () => {
    if (listenerUnsubscribe.current) {
      listenerUnsubscribe.current();
    }
    startListener();
  };

  // ---- Adicionar módulo (comportamento dual) ----
  const addModule = useCallback(async (usina: string, sub: string, code: string): Promise<boolean> => {
    // Verifica duplicidade local (inclui pendentes e oficiais)
    if (codesSet.has(code)) return false;

    const now = new Date();
    const timestamp = formatDateTime(now);

    if (isOnline) {
      // Online: salva direto no Firestore (sem pendente)
      try {
        const docRef = await addDoc(collection(db, 'ModulosDanificados'), {
          code,
          usina,
          subarea: sub,
          timestamp,
        });
        // Adiciona localmente como módulo oficial (sem fundo amarelo)
        const newMod: DamagedModule = {
          id: docRef.id,
          code,
          usina,
          subarea: sub,
          timestamp,
          pending: false,
        };
        setModules((prev) => [...prev, newMod].sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
        const newCodes = new Set(codesSet);
        newCodes.add(code);
        setCodesSet(newCodes);
        return true;
      } catch (error) {
        console.error('Erro ao salvar online:', error);
        Alert.alert('Erro', 'Falha ao salvar no servidor. Tente novamente.');
        return false;
      }
    } else {
      // Offline: salva localmente e mostra alerta
      const newMod: DamagedModule = {
        code,
        usina,
        subarea: sub,
        timestamp,
        pending: true,
      };
      const updatedModules = [...modules, newMod].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setModules(updatedModules);
      const newCodes = new Set(codesSet);
      newCodes.add(code);
      setCodesSet(newCodes);

      const updatedQueue = [...pendingQueue, newMod];
      await savePendingToStorage(updatedQueue);
      setPendingQueue(updatedQueue);

      Alert.alert('Salvo offline', 'O módulo foi salvo localmente e será enviado quando houver internet.');
      return true;
    }
  }, [modules, codesSet, pendingQueue, isOnline]);

  // ---- Monitoramento de conexão ----
  useEffect(() => {
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      const online = !!(state.isConnected && state.isInternetReachable);
      const wasOffline = !isOnline;
      setIsOnline(online);

      // Se acabou de voltar a internet, dispara sincronização
      if (online && wasOffline && pendingQueue.length > 0) {
        syncPending(pendingQueue);
      }
    });
    return () => unsubscribeNet();
  }, [pendingQueue, isOnline, syncPending]);

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
    startListener();
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
        isOnline,
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
  const { modules, codesSet, loading, syncError, addModule, isOnline } = useDamaged();
  const [selectedUsina, setSelectedUsina] = useState('');
  const [selectedSub, setSelectedSub] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // Foco automático assim que usina e subárea são selecionadas
  useEffect(() => {
    if (selectedUsina !== '' && selectedSub !== '') {
      // Pequeno atraso para garantir que o input esteja renderizado
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [selectedUsina, selectedSub]);

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
  const [usinaModalVisible, setUsinaModalVisible] = useState(false);
  const [selectedUsinaSubareas, setSelectedUsinaSubareas] = useState<
    { title: string; modules: DamagedModule[] }[]
  >([]);
  const [selectedUsinaName, setSelectedUsinaName] = useState('');
  const [subareaModalVisible, setSubareaModalVisible] = useState(false);
  const [selectedModules, setSelectedModules] = useState<DamagedModule[]>([]);
  const [selectedTitle, setSelectedTitle] = useState('');

  // Agrupa módulos: usina → subarea → módulos
  const groupedByUsina: Record<string, Record<string, DamagedModule[]>> = {};
  modules.forEach((mod) => {
    if (!groupedByUsina[mod.usina]) groupedByUsina[mod.usina] = {};
    if (!groupedByUsina[mod.usina][mod.subarea])
      groupedByUsina[mod.usina][mod.subarea] = [];
    groupedByUsina[mod.usina][mod.subarea].push(mod);
  });

  const usinaCards = Object.entries(groupedByUsina).map(([usina, subareas]) => {
    const totalModulos = Object.values(subareas).reduce(
      (sum, mods) => sum + mods.length,
      0
    );
    const subareasList = Object.entries(subareas).map(([sub, mods]) => ({
      title: `${usina} - ${sub}`,
      modules: mods,
    }));
    return { usina, totalModulos, subareas: subareasList };
  });

  const openUsinaModal = (usina: string, subareas: { title: string; modules: DamagedModule[] }[]) => {
    setSelectedUsinaName(usina);
    setSelectedUsinaSubareas(subareas);
    setUsinaModalVisible(true);
  };

  const openSubareaModal = (title: string, mods: DamagedModule[]) => {
    setUsinaModalVisible(false);
    setSelectedTitle(title);
    setSelectedModules(mods);
    setSubareaModalVisible(true);
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
        renderItem={({ item }) => (
          <View style={styles.usinaCard}>
            <Text style={styles.usinaCardTitle}>{item.usina}</Text>
            <Text style={styles.usinaCardSubtitle}>
              {item.totalModulos} módulo(s) no total
            </Text>
            <Button
              title="Detalhes"
              onPress={() => openUsinaModal(item.usina, item.subareas)}
            />
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.emptyText}>Nenhum módulo registrado.</Text>
        }
      />

      <Modal
        visible={usinaModalVisible}
        animationType="slide"
        onRequestClose={() => setUsinaModalVisible(false)}
      >
        <View style={styles.modalContainer}>
          <Text style={styles.modalTitle}>Subáreas de {selectedUsinaName}</Text>
          <FlatList
            data={selectedUsinaSubareas}
            keyExtractor={(item) => item.title}
            renderItem={({ item }) => (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{item.title}</Text>
                <Text style={styles.cardSubtitle}>
                  {item.modules.length} módulo(s)
                </Text>
                <Button
                  title="Detalhes"
                  onPress={() => openSubareaModal(item.title, item.modules)}
                />
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyText}>Nenhuma subárea encontrada.</Text>
            }
          />
          <View style={{ marginTop: 12 }}>
            <Button title="Fechar" onPress={() => setUsinaModalVisible(false)} />
          </View>
        </View>
      </Modal>

      <Modal
        visible={subareaModalVisible}
        animationType="slide"
        onRequestClose={() => setSubareaModalVisible(false)}
      >
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
          <View style={{ marginTop: 12 }}>
            <Button title="Fechar" onPress={() => setSubareaModalVisible(false)} />
          </View>
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
  usinaCard: {
    backgroundColor: '#e3f2fd',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    elevation: 3,
  },
  usinaCardTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#0d47a1',
    marginBottom: 4,
  },
  usinaCardSubtitle: {
    fontSize: 14,
    color: '#1565c0',
    marginBottom: 8,
  },
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
});