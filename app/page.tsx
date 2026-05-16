"use client";
import React, { useState, useEffect } from 'react';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

// ==========================================
// 1. Supabaseクライアントの初期化
// ==========================================
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default function BudgetBiteAI() {
  // 状態管理（ステート）
  const [budget, setBudget] = useState(25000);
  const [itemName, setItemName] = useState("");
  const [expense, setExpense] = useState("");
  const [stock, setStock] = useState(""); 
  const [userRequest, setUserRequest] = useState("1週間分の献立と買い物リストを教えて。");
  const [history, setHistory] = useState<{ id: string, name: string, price: number, date: string }[]>([]);
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);

  // Geminiの初期化
  const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY || "");
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // ==========================================
  // 2. 起動時にSupabaseから過去のデータを自動読み込み
  // ==========================================
  useEffect(() => {
    fetchBudgetData();
  }, []);

  const fetchBudgetData = async () => {
    // データベースから作成日時が新しい順（降順）でデータを取得
    const { data, error } = await supabase
      .from('budgets')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error("データ取得エラー:", error);
      return;
    }

    if (data && data.length > 0) {
      // 一番最新のレコードから「残り予算」を画面にセット
      setBudget(data[0].budget_amount);
      
      // 金額が入っている履歴だけを抽出して画面の一覧用に整形
      const formattedHistory = data
        .filter(item => item.expense_price > 0)
        .map(item => ({
          id: item.id,
          name: item.item_name || "買い物",
          price: item.expense_price,
          date: new Date(item.created_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) + " " + 
                new Date(item.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
        }));
      setHistory(formattedHistory);
    }
  };

 // ==========================================
  // 3. 出費を記録してSupabaseに保存する（デバッグ版）
  // ==========================================
  const addExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log("記録ボタンが押されたよ！入力値:", { itemName, expense });

    const price = parseInt(expense);
    const name = itemName || "買い物";

    if (isNaN(price) || price <= 0) {
      alert("金額を正しく入力してね！入力された値: " + expense);
      return;
    }

    const newBudget = budget - price;
    console.log("Supabaseに送信を開始します...", { budget_amount: newBudget, item_name: name, expense_price: price });

    try {
      // Supabaseの「budgets」テーブルにデータを1行挿入
      const { data, error } = await supabase
        .from('budgets')
        .insert([{
          budget_amount: newBudget,
          item_name: name,
          expense_price: price,
          stock_items: stock,
          user_request: userRequest,
          ai_response: aiResponse
        }])
        .select(); // 挿入されたデータを念のため受け取る

      if (error) {
        console.error("Supabaseのインサートでエラー発生:", error);
        alert("Supabaseへの保存に失敗しました: " + error.message);
        return;
      }

      console.log("Supabaseへの保存が成功したよ！返ってきたデータ:", data);

      // データベースへの保存が成功したら画面を更新
      setBudget(newBudget);
      await fetchBudgetData(); // 最新の履歴リストを再読込
      setExpense("");
      setItemName("");
      alert("保存に成功したよ！画面を更新します。");

    } catch (err) {
      console.error("プログラム実行中に重大なエラー:", err);
      alert("キャッチされたエラー: " + err);
    }
  };

  // ==========================================
  // 4. データをリセットして初期状態に戻す
  // ==========================================
  const resetData = async () => {
    if (confirm("データをリセットして、今月の予算を¥25,000に戻しますか？（過去のデータはすべて消去されます）")) {
      // Supabaseから全データを削除
      const { error } = await supabase
        .from('budgets')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // 全件削除のための条件

      if (error) {
        alert("リセットに失敗しました: " + error.message);
        return;
      }

      // 画面の状態も初期化
      setBudget(25000);
      setAiResponse("");
      setHistory([]);
      setStock("");
    }
  };

  // ==========================================
  // 5. Geminiにおまかせ献立を相談する
  // ==========================================
  const askGemini = async () => {
    setLoading(true);
    try {
      const prompt = `あなたは節約料理のプロです。現在の食費の残り予算は ${budget} 円です。
      
      【冷蔵庫に余っている食材】
      ${stock || "特になし"}

      【だいちゃんからのリクエスト】
      「${userRequest}」

      これらを考慮して、予算内で最高に美味しい献立と、不足している食材の買い物リストを作成してください。
      最後にだいちゃんへの温かい応援メッセージも添えて、綺麗で見やすいマークダウン形式で回答してね。`;
      
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      setAiResponse(text);

      // AIの回答が生成されたら、最新の予算状態と一緒にSupabaseへ追加保存する
      await supabase
        .from('budgets')
        .insert([{
          budget_amount: budget,
          item_name: "AI相談",
          expense_price: 0,
          stock_items: stock,
          user_request: userRequest,
          ai_response: text
        }]);

    } catch (error) {
      setAiResponse("エラーが発生しました。APIキーや環境変数の設定を確認してみてね。");
    }
    setLoading(false);
  };

  // ==========================================
  // 6. 画面の見た目（UI）
  // ==========================================
  return (
    <div className="min-h-screen bg-black text-gray-200 p-6 font-sans pb-20">
      <header className="max-w-md mx-auto mb-8 text-center">
        <h1 className="text-4xl font-bold text-cyan-400 tracking-tight italic">BudgetBite <span className="text-xs bg-cyan-900 text-cyan-200 px-2 py-0.5 rounded-full not-italic">AI</span></h1>
        <p className="text-gray-500 mt-2 text-sm uppercase tracking-widest font-light">Efficient Kitchen Management</p>
      </header>

      <main className="max-w-md mx-auto space-y-6">
        {/* 残り予算表示 */}
        <div className="relative overflow-hidden bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-8 shadow-2xl">
          <p className="text-xs uppercase tracking-widest text-gray-500 mb-1 font-bold text-center">Remaining Budget</p>
          <div className="text-5xl font-mono text-white my-2 font-bold text-center">¥{budget.toLocaleString()}</div>
          <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-4 overflow-hidden">
            <div className="bg-cyan-500 h-full transition-all duration-1000 ease-out" style={{ width: `${Math.max(0, (budget/25000)*100)}%` }}></div>
          </div>
        </div>

        {/* 出費記録フォーム */}
        <form onSubmit={addExpense} className="space-y-2 bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800">
          <p className="text-[10px] text-gray-500 px-2 uppercase tracking-widest font-bold">Quick Expense Record</p>
          <input 
            type="text" value={itemName} onChange={(e) => setItemName(e.target.value)}
            placeholder="メニュー名・店名 (例: スーパー、ラーメン)"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-500 transition-all"
          />
          <div className="flex gap-2">
            <input 
              type="number" value={expense} onChange={(e) => setExpense(e.target.value)}
              placeholder="金額"
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-lg font-mono focus:outline-none focus:border-cyan-500"
            />
            <button className="bg-white text-black px-6 py-3 rounded-xl font-bold active:scale-95 transition-all shadow-lg">記録</button>
          </div>
        </form>

        {/* AI相談入力フォーム */}
        <div className="bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800 space-y-4">
          <p className="text-[10px] text-gray-500 px-2 uppercase tracking-widest font-bold">AI Consultation</p>
          
          <div className="space-y-1">
            <label className="text-[10px] text-cyan-500 px-2 font-bold uppercase">余っている食材</label>
            <input 
              type="text" value={stock} onChange={(e) => setStock(e.target.value)}
              placeholder="例: たまご、キャベツ、豚肉"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] text-cyan-500 px-2 font-bold uppercase">リクエスト内容</label>
            <textarea 
              value={userRequest} onChange={(e) => setUserRequest(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 min-h-[80px] resize-none"
            />
          </div>

          <button onClick={askGemini} disabled={loading}
            className="w-full py-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-2xl font-bold shadow-xl active:scale-95 transition-all disabled:opacity-50"
          >
            {loading ? "Geminiが考え中..." : "AIコンシェルジュに相談する"}
          </button>
        </div>

        {/* 最近の履歴（直近3件を表示） */}
        {history.length > 0 && (
          <div className="bg-zinc-900/30 rounded-2xl p-4 border border-zinc-800">
            <p className="text-[10px] text-gray-500 px-2 mb-2 uppercase tracking-widest font-bold">Recent History</p>
            <div className="space-y-3">
              {history.slice(0, 3).map(item => (
                <div key={item.id} className="flex justify-between items-center px-2">
                  <div className="flex flex-col">
                    <span className="text-gray-300 text-sm">{item.name}</span>
                    <span className="text-[9px] text-gray-600 font-mono">{item.date}</span>
                  </div>
                  <span className="text-red-400 font-mono font-bold">-¥{item.price.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AIの回答表示エリア */}
        {aiResponse && (
          <div className="bg-zinc-900 border border-cyan-900/30 rounded-3xl p-6 shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="text-cyan-400 font-bold mb-4 flex items-center gap-2 border-b border-zinc-800 pb-2">✨ Geminiの提案</div>
            <div className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">{aiResponse}</div>
          </div>
        )}

        {/* データリセットボタン */}
        <div className="text-center pt-8">
          <button onClick={resetData} className="text-zinc-800 text-[10px] hover:text-red-500 transition-colors uppercase tracking-[0.2em] font-bold">
            Reset Data
          </button>
        </div>
      </main>
    </div>
  );
}