import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';

// 🌐 Endereço base do servidor. Muda AQUI (num só sítio) quando testares
// noutro sítio. Ex.: emulador Android -> 'http://10.0.2.2:3000'
//                    telemóvel real    -> 'http://<IP-do-PC>:3000'
const String baseUrl = 'http://localhost:3000';

// 🎨 Paleta da marca (igual à da web para um visual consistente)
const Color azulEscuro = Color(0xFF1D3557);
const Color azul = Color(0xFF457B9D);
const Color verde = Color(0xFF2A9D8F);
const Color vermelho = Color(0xFFE63946);
const Color fundo = Color(0xFFEEF1F6);

void main() async {
  // Necessário para ler o armazenamento antes de desenhar a app
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final token = prefs.getString('token');
  final armazemID = prefs.getString('armazemID');
  final nomeOperador = prefs.getString('nomeOperador');

  // Se já houver uma sessão guardada, vai direto para as tarefas; senão, login
  final Widget telaInicial = (token != null && armazemID != null)
      ? EcraTarefas(armazemID: armazemID, token: token, nomeOperador: nomeOperador ?? 'Operador')
      : const EcraLogin();

  runApp(MinhaApp(telaInicial: telaInicial));
}

class MinhaApp extends StatelessWidget {
  final Widget telaInicial;
  const MinhaApp({super.key, required this.telaInicial});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'BoxToCar Operador',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: azulEscuro, primary: azulEscuro),
        scaffoldBackgroundColor: fundo,
        // Barra do topo uniforme
        appBarTheme: const AppBarTheme(
          backgroundColor: azulEscuro,
          foregroundColor: Colors.white,
          elevation: 0,
          centerTitle: false,
        ),
        // Campos de texto arredondados e com "anel" ao focar
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: Color(0xFFD8DEE8))),
          enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: Color(0xFFD8DEE8))),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: azul, width: 2)),
        ),
        // Botões principais arredondados e consistentes
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: azulEscuro,
            foregroundColor: Colors.white,
            elevation: 0,
            padding: const EdgeInsets.symmetric(vertical: 14),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
          ),
        ),
        cardTheme: CardThemeData(
          elevation: 2,
          shadowColor: Colors.black.withValues(alpha: 0.15),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
      // 🚀 Começa no login OU direto nas tarefas, se já houver sessão guardada
      home: telaInicial,
    );
  }
}

// ==========================================
// 🚪 ECRÃ DE LOGIN
// ==========================================
class EcraLogin extends StatefulWidget {
  const EcraLogin({super.key});

  @override
  State<EcraLogin> createState() => _EcraLoginState();
}

class _EcraLoginState extends State<EcraLogin> {
  final _emailCtrl = TextEditingController();
  final _senhaCtrl = TextEditingController();
  bool _aCarregar = false;

  Future<void> fazerLogin() async {
    if (_emailCtrl.text.isEmpty || _senhaCtrl.text.isEmpty) return;

    setState(() => _aCarregar = true);

    try {
      // 1. Pede ao servidor para validar o utilizador
      final res = await http.post(
        Uri.parse('$baseUrl/api/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': _emailCtrl.text, 'senha': _senhaCtrl.text}),
      );

      if (res.statusCode == 200) {
        final dados = jsonDecode(res.body);

        final armazemID = dados['armazemId'].toString();
        final token = dados['token'] as String;
        final nomeOperador = dados['mensagem'].replaceAll('Bem-vindo, ', '').replaceAll('!', '');

        // 2. Login com Sucesso! Guarda a sessão para a app se manter "logada"
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('token', token);
        await prefs.setString('armazemID', armazemID);
        await prefs.setString('nomeOperador', nomeOperador);

        // 3. Vai para o ecrã de tarefas
        if (mounted) {
          Navigator.pushReplacement(
            context,
            MaterialPageRoute(
              builder: (context) => EcraTarefas(
                armazemID: armazemID,
                token: token,
                nomeOperador: nomeOperador,
              ),
            ),
          );
        }
      } else {
        // Erro (Ex: Senha errada)
        final erro = jsonDecode(res.body);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('❌ ${erro['erro']}'), backgroundColor: Colors.red));
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Erro ao contactar servidor.'), backgroundColor: Colors.red));
      }
    }
    setState(() => _aCarregar = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        // Fundo com gradiente azul-escuro (igual à web)
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [azulEscuro, Color(0xFF14233C)],
          ),
        ),
        child: Center(
          child: SingleChildScrollView(
            child: Container(
              width: 350,
              margin: const EdgeInsets.all(20),
              padding: const EdgeInsets.all(28),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16), boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 24, offset: Offset(0, 8))]),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Image.asset('assets/logo.png', height: 80, errorBuilder: (c, e, s) => const Icon(Icons.warehouse, size: 60, color: azulEscuro)),
                  const SizedBox(height: 10),
                  const Text('BoxToCar Operador', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: azulEscuro)),
                  const SizedBox(height: 4),
                  const Text('Inicia sessão para continuar', style: TextStyle(fontSize: 13, color: Colors.black54)),
                  const SizedBox(height: 28),
                  TextField(
                    controller: _emailCtrl,
                    decoration: const InputDecoration(labelText: 'Email', prefixIcon: Icon(Icons.email_outlined)),
                  ),
                  const SizedBox(height: 15),
                  TextField(
                    controller: _senhaCtrl,
                    obscureText: true,
                    decoration: const InputDecoration(labelText: 'Senha', prefixIcon: Icon(Icons.lock_outline)),
                  ),
                  const SizedBox(height: 24),
                  SizedBox(
                    width: double.infinity,
                    height: 48,
                    child: ElevatedButton(
                      onPressed: _aCarregar ? null : fazerLogin,
                      child: _aCarregar
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                        : const Text('ENTRAR'),
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: () {
                      Navigator.push(context, MaterialPageRoute(builder: (context) => const EcraRegistoOperador()));
                    },
                    style: TextButton.styleFrom(foregroundColor: azul),
                    child: const Text('Não tens conta? Cria uma aqui'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ==========================================
// 📝 ECRÃ DE REGISTO DE OPERADOR
// ==========================================
class EcraRegistoOperador extends StatefulWidget {
  const EcraRegistoOperador({super.key});

  @override
  State<EcraRegistoOperador> createState() => _EcraRegistoOperadorState();
}

class _EcraRegistoOperadorState extends State<EcraRegistoOperador> {
  final _nomeCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _senhaCtrl = TextEditingController();

  List _armazens = [];
  int? _armazemSelecionado;
  bool _aCarregar = true; // a carregar a lista de armazéns
  bool _aRegistar = false;

  @override
  void initState() {
    super.initState();
    buscarArmazens();
  }

  Future<void> buscarArmazens() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/armazens'));
      if (res.statusCode == 200) {
        setState(() {
          _armazens = jsonDecode(res.body);
          _aCarregar = false;
        });
      } else {
        setState(() => _aCarregar = false);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Erro ao carregar armazéns.'), backgroundColor: Colors.red));
      }
      setState(() => _aCarregar = false);
    }
  }

  Future<void> fazerRegisto() async {
    if (_nomeCtrl.text.isEmpty || _emailCtrl.text.isEmpty || _senhaCtrl.text.isEmpty || _armazemSelecionado == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Preenche tudo e escolhe um armazém.'), backgroundColor: Colors.orange));
      return;
    }

    setState(() => _aRegistar = true);

    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/operador/registo'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'nome': _nomeCtrl.text,
          'email': _emailCtrl.text,
          'senha': _senhaCtrl.text,
          'armazemID': _armazemSelecionado,
        }),
      );

      final dados = jsonDecode(res.body);
      if (res.statusCode == 201) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('✅ ${dados['mensagem']}'), backgroundColor: Colors.green));
          Navigator.pop(context); // volta ao login
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('❌ ${dados['erro']}'), backgroundColor: Colors.red));
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Erro ao contactar servidor.'), backgroundColor: Colors.red));
      }
    }
    if (mounted) setState(() => _aRegistar = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Criar Conta de Operador'),
      ),
      body: _aCarregar
          ? const Center(child: CircularProgressIndicator())
          : Center(
              child: SingleChildScrollView(
                child: Container(
                  width: 350,
                  padding: const EdgeInsets.all(28),
                  margin: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16), boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 16, offset: Offset(0, 6))]),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.person_add_alt_1, size: 54, color: azulEscuro),
                      const SizedBox(height: 20),
                      TextField(
                        controller: _nomeCtrl,
                        decoration: const InputDecoration(labelText: 'Nome', prefixIcon: Icon(Icons.person_outline)),
                      ),
                      const SizedBox(height: 15),
                      TextField(
                        controller: _emailCtrl,
                        decoration: const InputDecoration(labelText: 'Email', prefixIcon: Icon(Icons.email_outlined)),
                      ),
                      const SizedBox(height: 15),
                      TextField(
                        controller: _senhaCtrl,
                        obscureText: true,
                        decoration: const InputDecoration(labelText: 'Senha', prefixIcon: Icon(Icons.lock_outline)),
                      ),
                      const SizedBox(height: 15),
                      DropdownButtonFormField<int>(
                        initialValue: _armazemSelecionado,
                        isExpanded: true,
                        decoration: const InputDecoration(labelText: 'Armazém', prefixIcon: Icon(Icons.warehouse)),
                        hint: const Text('Escolhe o armazém'),
                        items: _armazens.map<DropdownMenuItem<int>>((a) {
                          final cidade = (a['Cidade'] != null && a['Cidade'].toString().isNotEmpty) ? ' (${a['Cidade']})' : '';
                          return DropdownMenuItem<int>(
                            value: a['ID'],
                            child: Text('${a['Nome']}$cidade', overflow: TextOverflow.ellipsis),
                          );
                        }).toList(),
                        onChanged: (v) => setState(() => _armazemSelecionado = v),
                      ),
                      const SizedBox(height: 25),
                      SizedBox(
                        width: double.infinity,
                        height: 48,
                        child: ElevatedButton(
                          onPressed: _aRegistar ? null : fazerRegisto,
                          child: _aRegistar
                              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                              : const Text('CRIAR CONTA'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
    );
  }
}

// ==========================================
// 📋 ECRÃ DE TAREFAS
// ==========================================
class EcraTarefas extends StatefulWidget {
  final String armazemID; // 🔑 Recebe a chave do ecrã de Login!
  final String token; // 🎫 Token de login para autorizar os pedidos
  final String nomeOperador;

  const EcraTarefas({super.key, required this.armazemID, required this.token, required this.nomeOperador});

  @override
  State<EcraTarefas> createState() => _EcraTarefasState();
}

class _EcraTarefasState extends State<EcraTarefas> {
  List tarefas = [];
  bool aCarregar = true;

  @override
  void initState() {
    super.initState();
    buscarTarefas();
  }

  Future<void> buscarTarefas() async {
    try {
      // 🔑 Usa a chave específica deste operador no URL + envia o token de login
      final resposta = await http.get(
        Uri.parse('$baseUrl/api/tarefas/pendentes?armazemID=${widget.armazemID}'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );

      if (resposta.statusCode == 200) {
        final dados = json.decode(resposta.body);
        setState(() {
          tarefas = (dados is List) ? dados : [];
          aCarregar = false;
        });
      } else if (resposta.statusCode == 401) {
        // Token inválido ou expirado -> termina a sessão
        terminarSessao(expirada: true);
      }
    } catch (e) {
      debugPrint('Erro de ligação: $e');
      setState(() => aCarregar = false);
    }
  }

  // Limpa a sessão guardada e volta ao ecrã de login
  Future<void> terminarSessao({bool expirada = false}) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('token');
    await prefs.remove('armazemID');
    await prefs.remove('nomeOperador');
    if (!mounted) return;
    if (expirada) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('A tua sessão expirou. Faz login outra vez.'), backgroundColor: Colors.orange),
      );
    }
    Navigator.pushReplacement(context, MaterialPageRoute(builder: (context) => const EcraLogin()));
  }

  Future<void> confirmarTarefa(int idTarefa) async {
    try {
      final resposta = await http.post(
        Uri.parse('$baseUrl/api/operador/concluir'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${widget.token}',
        },
        body: json.encode({'encomendaId': idTarefa}),
      );

      if (resposta.statusCode == 200) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('✅ Recolha confirmada!'), backgroundColor: Colors.green));
        buscarTarefas(); // Atualiza a lista
      } else if (resposta.statusCode == 401) {
        terminarSessao(expirada: true);
      } else {
        final erro = jsonDecode(resposta.body);
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('❌ ${erro['erro']}'), backgroundColor: Colors.red));
      }
    } catch (e) {
      debugPrint('Erro ao confirmar: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Tarefas · ${widget.nomeOperador}'), // Mostra o nome do Operador
        actions: [
          IconButton(
            tooltip: 'Atualizar',
            icon: const Icon(Icons.refresh),
            onPressed: () {
              setState(() => aCarregar = true);
              buscarTarefas();
            },
          ),
          IconButton(
            tooltip: 'Sair',
            icon: const Icon(Icons.exit_to_app),
            onPressed: () => terminarSessao(), // Limpa a sessão guardada e volta ao login
          )
        ],
      ),
      body: aCarregar
          ? const Center(child: CircularProgressIndicator())
          : tarefas.isEmpty
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.check_circle_outline, size: 72, color: verde),
                      const SizedBox(height: 12),
                      const Text('Não há tarefas!', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: azulEscuro)),
                      const SizedBox(height: 4),
                      const Text('Bom trabalho 🎉', style: TextStyle(fontSize: 15, color: Colors.black54)),
                    ],
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  itemCount: tarefas.length,
                  itemBuilder: (context, index) {
                    final t = tarefas[index];
                    return Card(
                      margin: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
                      child: Padding(
                        padding: const EdgeInsets.all(16.0),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(10),
                                  decoration: BoxDecoration(color: azul.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
                                  child: const Icon(Icons.inventory_2_outlined, color: azul),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Text(
                                    '${t['Quantidade']}x ${t['Produto']}',
                                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: azulEscuro),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 14),
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                              decoration: BoxDecoration(color: fundo, borderRadius: BorderRadius.circular(10)),
                              child: Row(
                                children: [
                                  const Icon(Icons.place_outlined, size: 18, color: Colors.black54),
                                  const SizedBox(width: 6),
                                  Text(
                                    'X: ${t['PosX']}   ·   Y: ${t['PosY']}   ·   Nível: ${t['Nivel']}',
                                    style: const TextStyle(fontSize: 15, color: Colors.black87, fontWeight: FontWeight.w500),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 16),
                            SizedBox(
                              width: double.infinity,
                              height: 50,
                              child: ElevatedButton.icon(
                                style: ElevatedButton.styleFrom(backgroundColor: verde),
                                onPressed: () => confirmarTarefa(t['TarefaID']),
                                icon: const Icon(Icons.check, color: Colors.white),
                                label: const Text('CONFIRMAR RECOLHA', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white)),
                              ),
                            )
                          ],
                        ),
                      ),
                    );
                  },
                ),
    );
  }
}