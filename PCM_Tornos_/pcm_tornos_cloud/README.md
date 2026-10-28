# PCM Tornos — versão conectada

Esta entrega preserva a interface e os módulos do PCM original e acrescenta uma API Node.js, autenticação individual, controle de permissão no servidor e persistência em PostgreSQL.

## Arquitetura

- `public/PCM_Tornos_Cloud.html`: interface existente adaptada para consumir a API.
- `public/importar_dados.html`: ferramenta de importação inicial de um backup JSON.
- `server.js`: API, autenticação, controle de acesso e persistência.
- `package.json`: dependências e comando de inicialização.
- `.env.example`: variáveis de ambiente necessárias.
- `schema.sql`: modelo relacional PostgreSQL com as 17 tabelas solicitadas, chaves estrangeiras, índices, checks, campos de auditoria e views para valores derivados.
- PostgreSQL: a API desta versão ainda usa `pcm_state` como camada de compatibilidade JSON para preservar o funcionamento da interface legada. O schema relacional está definido, mas os endpoints atuais ainda precisam ser migrados para gravar/consultar diretamente cada tabela antes de considerar a arquitetura plenamente normalizada e pronta para uso operacional.

## Antes de colocar em uso real

1. Crie um banco PostgreSQL gerenciado e um serviço para executar Node.js. Pode ser um serviço de aplicação e um PostgreSQL hospedados no mesmo provedor ou em provedores compatíveis.
2. Configure as variáveis de ambiente do serviço, usando os valores reais do provedor:
   - `DATABASE_URL`: string de conexão PostgreSQL.
   - `JWT_SECRET`: segredo aleatório longo para assinar sessões.
   - `BOOTSTRAP_TOKEN`: token aleatório longo, usado apenas na importação inicial.
   - `PORT`: normalmente definido pelo provedor; localmente pode ser `3000`.
   - `PGSSL`: `true` quando o provedor exigir SSL na conexão com PostgreSQL.
3. Não publique o arquivo `.env` nem coloque segredos no HTML. Use o gerenciador de variáveis secretas do provedor.
4. Execute `schema.sql` no banco PostgreSQL para criar as tabelas relacionais e as views. A API também cria `pcm_state` automaticamente como camada temporária de compatibilidade.
5. Configure um domínio próprio no provedor de hospedagem e siga as instruções DNS exibidas por ele. Ative/valide HTTPS antes de usar credenciais reais.
6. Abra `https://SEU-DOMINIO/importar_dados.html` para a migração inicial.

## Migrar os dados locais

1. No arquivo antigo do PCM, abra **Configurações → Exportar backup (JSON)** no navegador que contém os registros atuais.
2. Guarde o JSON em local seguro. Ele contém dados de manutenção e, na versão antiga, hashes de senha dos usuários.
3. Abra a página `importar_dados.html` no servidor publicado, informe o `BOOTSTRAP_TOKEN` configurado no ambiente e selecione o backup.
4. A importação só funciona quando o banco está vazio e só pode ocorrer uma vez.
5. Entre no PCM com uma conta que já existia no backup. No primeiro login, a senha legada é verificada no servidor e seu hash é convertido para bcrypt.
6. Altere a senha inicial do administrador, confira equipamentos, indicadores, OS, estoque, custos e histórico antes de liberar o sistema à equipe.
7. Depois da importação, troque o `BOOTSTRAP_TOKEN` por outro valor aleatório nas variáveis do servidor (a variável precisa continuar definida para o serviço iniciar). O endpoint de bootstrap também recusa qualquer importação quando o banco já está inicializado.

Se não houver dados a migrar, inicie o sistema antigo sem registros, exporte o backup e use o mesmo processo. Não existe uma conta padrão criada automaticamente pelo servidor.

## Usuários e permissões

- Administrador: gerenciamento de usuários e acesso completo.
- Gestor de manutenção: módulos operacionais e configurações operacionais permitidas pelo perfil.
- Técnico: falhas e ordens de serviço, conforme as permissões do sistema.
- Operador: registro de falhas.

A API valida o perfil atual no servidor e limita quais grupos de dados cada perfil pode alterar. Usuários novos e redefinições de senha passam por `/api/users`; as senhas novas são armazenadas com bcrypt. A senha de uma conta migrada é atualizada para bcrypt após autenticação bem-sucedida.

## Backups e concorrência

- Configure backups automáticos do PostgreSQL no provedor e teste a restauração periodicamente.
- A exportação JSON da interface salva os dados operacionais disponíveis no cliente, mas não inclui as credenciais de senha do servidor. A criação/alteração de usuários deve ser feita pela tela **Usuários**.
- Se duas pessoas editarem os dados ao mesmo tempo, o sistema usa uma versão do estado para detectar conflito. Quando surgir um aviso de conflito, interrompa as alterações e atualize a página para carregar os dados atuais.
- **Atenção: não liberar para produção com dados reais ainda.** A interface e API legadas ainda enviam snapshots JSON; elas não usam automaticamente as tabelas relacionais novas. Antes do uso operacional, implementar e testar os endpoints CRUD por entidade, migração JSON→relacional transacional, autorização por registro e testes de concorrência. Não mantenha `pcm_state` como fonte paralela definitiva, pois isso cria risco de divergência.

## Teste local

Requisitos: Node.js 20+ e PostgreSQL acessível.

```bash
npm install
cp .env.example .env
# Edite .env com credenciais reais e segredos aleatórios
npm start
```

Acesse `http://localhost:3000/PCM_Tornos_Cloud.html`. Para inicializar o banco, exporte um JSON de backup do sistema antigo e importe em `http://localhost:3000/importar_dados.html`.

## Limitações importantes

- A interface usa algumas bibliotecas externas via CDN (gráficos, PDF, Excel e QR Code), portanto o navegador precisa acessar esses recursos para todas as funções.
- O sistema exige conexão com o servidor para salvar e carregar dados. Não há modo offline de edição.
- A migração inicial deve ser feita com cuidado e validada antes de descartar o arquivo antigo. Mantenha o backup original protegido até confirmar a integridade de todos os registros.
- Antes do uso operacional definitivo, faça testes de permissão com contas de cada perfil, teste a recuperação de backup e valide os procedimentos de segurança e privacidade da empresa.
