/**
 * Свежесть прайса поставщика (materials.db — живые цены ВРЭП/Металлинвест).
 *
 * Раньше жило в wiki/SupplierDetail.tsx рядом с экраном поставщика. Сам экран оказался
 * мёртвым: категория «Поставщики» в вики — это отфильтрованные по роли `masters`, и
 * рендерит её ContractorDetail (wiki/registry.tsx). Компонент со своей формой удалён,
 * а эти две живые части переехали сюда — чтобы имя файла не обещало несуществующий экран.
 */
import { useQuery } from "@tanstack/react-query";
import { materialsApi } from "../../api";
import { MONO } from "../../components/ui/Num";
import { DetailSection } from "./DetailShell";

// Код прайса materials.db → метка (справочно; join не строим).
export const PRICE_SUPPLIER_LABELS: Record<string, string> = {
  vrep: "ВРЭП", metplus: "Металлинвест",
};

export function PriceSync({ code }: { code: string }) {
  const { data } = useQuery({
    queryKey: ["supplier-sync", code],
    queryFn: () => materialsApi.supplierSync(code),
  });
  if (!data?.last_date) return null;
  return (
    <DetailSection label="ПРАЙС">
      <div style={{ fontSize: 13, color: "#1A1A1A" }}>
        {PRICE_SUPPLIER_LABELS[code] || code} · обновлён{" "}
        <span style={{ fontFamily: MONO }}>{data.last_date}</span>
        <span style={{ color: "#A89070" }}> · {new Intl.NumberFormat("ru-RU").format(data.count)} позиций</span>
      </div>
    </DetailSection>
  );
}
