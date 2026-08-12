import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

interface Item {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
}

/** ダッシュボード (最小実装)。テナントスコープの /api/items を叩く。 */
export function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["items"],
    queryFn: async (): Promise<Item[]> => {
      const res = await fetch("/api/items");
      if (!res.ok) throw new Error("failed to load items");
      const body = (await res.json()) as { items: Item[] };
      return body.items;
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>ダッシュボード</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <p className="text-sm text-slate-500">読み込み中...</p>}
          {error && <p className="text-sm text-red-600">読み込みに失敗しました</p>}
          {data && data.length === 0 && <p className="text-sm text-slate-500">アイテムはまだありません</p>}
          <ul className="flex flex-col gap-2">
            {data?.map((item) => (
              <li key={item.id} className="rounded-md border border-slate-200 p-3 text-sm">
                {item.name}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
