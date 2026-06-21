import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

void main() {
  runApp(const MinhaApp());
}

class MinhaApp extends StatelessWidget {
  const MinhaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'WMS Operador',
      theme: ThemeData(
        primarySwatch: Colors.blue,
        scaffoldBackgroundColor: Colors.grey[100],
      ),
      // 🚀 A APP AGORA COMEÇA NO ECRÃ DE LOGIN!
      home: const EcraLogin(), 
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
        Uri.parse('http://localhost:3000/api/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': _emailCtrl.text, 'senha': _senhaCtrl.text}),
      );

      if (res.statusCode == 200) {
        final dados = jsonDecode(res.body);
        
        // 2. Login com Sucesso! Passamos o ArmazemID para o próximo ecrã
        if (mounted) {
          Navigator.pushReplacement(
            context,
            MaterialPageRoute(
              builder: (context) => EcraTarefas(
                armazemID: dados['armazemId'].toString(), 
                nomeOperador: dados['mensagem'].replaceAll('Bem-vindo, ', '').replaceAll('!', '')
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
      body: Center(
        child: Container(
          width: 350,
          padding: const EdgeInsets.all(24),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 10)]),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.warehouse, size: 60, color: Colors.blue),
              const SizedBox(height: 10),
              const Text('WMS Operador', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
              const SizedBox(height: 30),
              TextField(
                controller: _emailCtrl,
                decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder(), prefixIcon: Icon(Icons.email)),
              ),
              const SizedBox(height: 15),
              TextField(
                controller: _senhaCtrl,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'Senha', border: OutlineInputBorder(), prefixIcon: Icon(Icons.lock)),
              ),
              const SizedBox(height: 25),
              SizedBox(
                width: double.infinity,
                height: 45,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(backgroundColor: Colors.blue[800], foregroundColor: Colors.white),
                  onPressed: _aCarregar ? null : fazerLogin,
                  child: _aCarregar 
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                    : const Text('ENTRAR', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                ),
              )
            ],
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
  final String nomeOperador;

  const EcraTarefas({super.key, required this.armazemID, required this.nomeOperador});

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
      // 🔑 Usa a chave específica deste operador no URL
      final resposta = await http.get(Uri.parse('http://localhost:3000/api/tarefas/pendentes?armazemID=${widget.armazemID}'));
      
      if (resposta.statusCode == 200) {
        final dados = json.decode(resposta.body);
        setState(() {
          tarefas = (dados is List) ? dados : [];
          aCarregar = false;
        });
      }
    } catch (e) {
      print('Erro de ligação: $e');
      setState(() => aCarregar = false);
    }
  }

  Future<void> confirmarTarefa(int idTarefa) async {
    try {
      final resposta = await http.post(
        Uri.parse('http://localhost:3000/api/operador/concluir'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'encomendaId': idTarefa}),
      );

      if (resposta.statusCode == 200) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('✅ Recolha confirmada!'), backgroundColor: Colors.green));
        buscarTarefas(); // Atualiza a lista
      } else {
        final erro = jsonDecode(resposta.body);
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('❌ ${erro['erro']}'), backgroundColor: Colors.red));
      }
    } catch (e) {
      print('Erro ao confirmar: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Tarefas - ${widget.nomeOperador}'), // Mostra o nome do Operador
        backgroundColor: Colors.blue[800],
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () {
              setState(() => aCarregar = true);
              buscarTarefas();
            },
          ),
          IconButton(
            icon: const Icon(Icons.exit_to_app),
            onPressed: () {
              // Faz Logout e volta ao ecrã inicial
              Navigator.pushReplacement(context, MaterialPageRoute(builder: (context) => const EcraLogin()));
            },
          )
        ],
      ),
      body: aCarregar 
          ? const Center(child: CircularProgressIndicator())
          : tarefas.isEmpty 
              ? const Center(child: Text('Não há tarefas! Bom trabalho 🎉', style: TextStyle(fontSize: 20)))
              : ListView.builder(
                  itemCount: tarefas.length,
                  itemBuilder: (context, index) {
                    final t = tarefas[index];
                    return Card(
                      margin: const EdgeInsets.all(12),
                      elevation: 4,
                      child: Padding(
                        padding: const EdgeInsets.all(16.0),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Apanhar: ${t['Quantidade']}x ${t['Produto']}',
                              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                            ),
                            const SizedBox(height: 10),
                            Text(
                              '📍 Prateleira X:${t['PosX']} | Y:${t['PosY']} | Nível: ${t['Nivel']}',
                              style: const TextStyle(fontSize: 16, color: Colors.black87),
                            ),
                            const SizedBox(height: 20),
                            SizedBox(
                              width: double.infinity,
                              height: 50,
                              child: ElevatedButton(
                                style: ElevatedButton.styleFrom(backgroundColor: Colors.green),
                                onPressed: () => confirmarTarefa(t['TarefaID']),
                                child: const Text('CONFIRMAR RECOLHA', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.white)),
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