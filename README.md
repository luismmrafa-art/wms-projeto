# BoxToCar — Sistema de Gestão de Armazém (Picking)

Sistema de gestão de armazém (*Warehouse Management System*) com mapa interativo,
controlo de stock e picking. Cada **Gestor** cria o seu armazém e os **Operadores**
fazem a recolha de produtos através de uma app móvel.

O projeto tem três partes:

| Parte | Tecnologia | Descrição |
|-------|-----------|-----------|
| **Backend / API** | Node.js + Express + MySQL | API REST com autenticação JWT |
| **Painel web (Gestor)** | HTML / CSS / JS | Mapa do armazém, stock e encomendas |
| **App do Operador** | Flutter | Lista de tarefas e confirmação de recolha |

---

## Funcionalidades

-  **Autenticação** com JWT e senhas encriptadas (bcrypt)
-  **Multi-armazém** — cada conta só vê e mexe nos dados do seu armazém
-  **Mapa interativo** do armazém (prateleiras, níveis e posição do robô)
-  Entrada de produtos e construção de prateleiras, com **validação física**
   de encaixe (dimensões do artigo vs. prateleira) e de acessibilidade
   (nenhuma prateleira pode ficar sem célula de acesso livre)
-  **Catálogo de tipos de robô** e **recomendação automática** por armazém
   (largura do corredor + perfil de carga), com possibilidade de fixação
   manual pelo gestor
-  **Decisão multicritério** humano-robô por recolha (peso, fragilidade,
   capacidade do robô, tempo do operador vs. tempo do robô)
-  **Três algoritmos de planeamento** para lotes de recolhas — exato (força
   bruta, até 7 tarefas), heurística gulosa e meta-heurística de recozimento
   simulado — comparáveis lado a lado
-  Simulador de ordens de picking (carrinho com validação de stock)
-  **App do operador** para ver tarefas, consultar o ponto de encontro com o
   robô e concluir recolhas
-  Registo de operadores por **código de convite** do armazém
-  Vários operadores podem partilhar o mesmo armazém

---

## Estrutura do projeto

```
projeto-picking/
├── backend/                 # API + painel web
│   ├── server.js            # Rotas da API e servidor Express
│   ├── db.js                # Ligação (pool) ao MySQL
│   ├── migrate.js           # Migração de esquema (idempotente, corre-se com `node migrate.js`)
│   ├── coordenacao.js       # BFS, ponto de encontro e rotas sobre a grelha do armazém
│   ├── robos.js             # Catálogo de tipos de robô e recomendação automática (SAD)
│   ├── custoDecisao.js      # Decisão multicritério humano-robô por recolha
│   ├── algoritmos.js        # Os três algoritmos de planeamento (exato, guloso, meta-heurística)
│   ├── artigos.js           # Dados mestre do artigo e validação de encaixe físico
│   ├── .env                 # Configuração (NÃO versionado)
│   └── public/              # Frontend web servido pelo Express
│       ├── login.html
│       ├── registo.html
│       ├── index.html       # Painel do Gestor
│       └── estilo.css       # Estilos partilhados
└── app_operador/            # App Flutter do operador
    └── lib/main.dart
```

---

## Pré-requisitos

- [Node.js](https://nodejs.org/) (versão 18 ou superior)
- **MySQL** — por exemplo via [XAMPP](https://www.apachefriends.org/) (com phpMyAdmin)
- [Flutter](https://flutter.dev/) (só necessário para a app do operador)

---

## Como correr

### 1. Base de dados
1. Inicia o MySQL (ex.: no painel do XAMPP).
2. No phpMyAdmin, cria uma base de dados vazia chamada **`projeto_picking`**.
3. O esquema (tabelas, colunas e chaves estrangeiras) é criado por código —
   não é preciso criar tabelas manualmente. Ver passo 2.

### 2. Backend + painel web
```bash
cd backend
npm install
```

Cria o ficheiro **`backend/.env`** (vê o exemplo em [`.env.example`](backend/.env.example)):
```env
DB_USER=root
DB_PASSWORD=
DB_SERVER=localhost
DB_NAME=projeto_picking
PORT=3000
JWT_SECRET=coloca-aqui-uma-frase-secreta-longa-e-aleatoria
```

Cria/atualiza o esquema da base de dados (idempotente — pode ser corrido
várias vezes em segurança):
```bash
node migrate.js
```

Arranca o servidor:
```bash
node server.js
```
O painel fica disponível em **http://localhost:3000** (abre primeiro o `login.html`).

### 3. App do operador (Flutter)
```bash
cd app_operador
flutter pub get
flutter run
```

> O endereço do servidor está numa só constante no topo de
> [`lib/main.dart`](app_operador/lib/main.dart) (`baseUrl`). Muda-a conforme onde testas:
> - **Web/Windows:** `http://localhost:3000`
> - **Emulador Android:** `http://10.0.2.2:3000`
> - **Telemóvel real:** `http://<IP-do-teu-PC>:3000`

---

## 🔌 Principais rotas da API

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| `POST` | `/api/registo` | público | Cria armazém novo + conta de Gestor |
| `POST` | `/api/operador/registo` | público | Cria conta de Operador num armazém, por código de convite |
| `POST` | `/api/login` | público | Login (devolve token JWT) |
| `GET`  | `/api/armazens` | público | Lista de armazéns (para o registo do operador) |
| `GET`  | `/api/armazem/codigo-convite` | token | Código de convite do armazém do gestor |
| `GET`  | `/api/inventario` | token | Prateleiras e produtos do armazém |
| `POST` | `/api/produtos/novo` | token | Dar entrada de um produto (com validação de encaixe físico) |
| `POST` | `/api/prateleiras/nova` | token | Construir uma prateleira (com validação de acessibilidade) |
| `POST` | `/api/armazem/importar` | token | Importar uma planta completa do armazém (JSON) |
| `GET`  | `/api/armazem/config` / `POST` | token | Ler/gravar corredor, robô fixado e tamanho das prateleiras |
| `GET`  | `/api/robos/tipos` | token | Catálogo de tipos de robô |
| `GET`  | `/api/robos/recomendar` | token | Recomendação automática de robô para o armazém (SAD) |
| `GET`  | `/api/coordenacao/plano` | token | Ponto de encontro, rotas e decisão multicritério para uma recolha |
| `GET`  | `/api/planeamento/otimizar` | token | Compara os três algoritmos sobre as tarefas pendentes do armazém |
| `GET`  | `/api/tarefas/pendentes` | token | Tarefas de picking do operador |
| `POST` | `/api/operador/concluir` | token | Confirmar recolha (baixa de stock) |
| `GET`  | `/api/gestor/encomendas` | token | Últimas encomendas do armazém |
| `POST` | `/api/encomendas/carrinho` | token | Gerar ordem de picking (com validação de stock) |



---

##  Segurança

- Senhas guardadas como *hash* **bcrypt** (nunca em texto simples)
- Rotas sensíveis protegidas por **token JWT** (validade de 8 horas)
- O `armazemID` vem sempre do token, não do cliente (isolamento entre armazéns)
- O ficheiro `.env` (credenciais e `JWT_SECRET`) **não** é versionado no Git

---

##  Autor

Projeto desenvolvido por **Luís** ([@luismmrafa-art](https://github.com/luismmrafa-art)).
