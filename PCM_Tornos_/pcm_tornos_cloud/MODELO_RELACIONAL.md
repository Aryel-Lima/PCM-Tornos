# Modelo relacional do banco de dados — PCM Tornos

O arquivo `schema.sql` define o modelo PostgreSQL para:

- `users`, `roles`
- `equipment`, `equipment_documents`
- `operating_records`, `performance_indicators`
- `failures`, `work_orders`
- `preventive_plans`, `preventive_tasks`
- `inventory_items`, `inventory_movements`
- `suppliers`, `supplier_quotes`, `work_order_items`
- `maintenance_costs`, `audit_logs`

## Integridade e rastreabilidade

- Chaves primárias `BIGINT GENERATED ... AS IDENTITY` em todas as entidades.
- Chaves estrangeiras com regras de exclusão adequadas para preservar histórico; documentos e tarefas dependentes podem ser removidos junto com seu pai.
- `UNIQUE`, `CHECK`, índices de consulta por equipamento, estado, data, usuário e referências de origem.
- Campos `created_at`, `updated_at`, `created_by` e `updated_by` nas tabelas mutáveis. `audit_logs` é append-only e guarda ator, instante, ação, entidade, valores anteriores/novos e metadados da requisição.
- `performance_indicators.operating_record_id` liga a medição ao registro operacional que a originou. Campos de origem adicionais permitem rastrear medições manuais, importadas ou provenientes de sensores.
- Resultados derivados não devem ser copiados para colunas editáveis: `v_performance_indicators_trace` expõe a origem das medições; `v_inventory_balances` calcula saldo a partir das movimentações; `v_inventory_reorder_alerts` calcula alertas de reposição; `v_maintenance_cost_totals` calcula o total da linha de custo.

## Relações principais

- `roles 1:N users`
- `equipment 1:N equipment_documents`, `operating_records`, `performance_indicators`, `failures`, `preventive_plans`, `work_orders` e `maintenance_costs`
- `operating_records 1:N performance_indicators`; falhas podem referenciar o registro operacional de origem
- `failures 1:N work_orders` (opcional por OS)
- `preventive_plans 1:N preventive_tasks` e planos podem originar ordens de serviço
- `work_orders N:N inventory_items` por `work_order_items`
- `inventory_items 1:N inventory_movements`
- `suppliers 1:N supplier_quotes`; fornecedores podem ser associados aos custos

## Migração e situação da API

O schema é a estrutura de destino. A API atualmente empacotada ainda usa `pcm_state` para manter a interface original compatível. Não se deve considerar o sistema plenamente relacional até substituir os endpoints de snapshot por operações transacionais por tabela e validar a importação do backup legado. A migração deve preservar os IDs antigos em colunas de referência de origem ou em uma tabela de correspondência, validar contagens e vínculos e somente então desativar `pcm_state`.
