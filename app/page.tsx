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

interface ShoppingItem {
  id: string;
  name: string;
  checked: boolean;
}

interface ShoppingSection {
  title: string;
  items: ShoppingItem[];
}

export default function BudgetBiteAI() {
  // 状態管理（ステート）
  const [budget, setBudget] = useState(25000);
  const [itemName, setItemName] = useState("");
  const [expense, setExpense] = useState("");
  const [stock, setStock] = useState(""); 
  const [userRequest, setUserRequest] = useState("1週間3500円程度で、平日の夜に時間がなくてもパパッと作れる時短レシピにして！");
  const [history, setHistory] = useState<{ id: string, name: string, price: number, date: string }[]>([]);
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);
  
  // 表示するタブを管理するステート（'menu' = 献立, 'shopping' = 買い物リスト）
  const [activeTab, setActiveTab] = useState<'menu' | 'shopping'>('menu');

  // 🛒 買い物リストのチェック状態を管理するステート
  const [shoppingSections, setShoppingSections] = useState<ShoppingSection[]>([]);

  // Geminiの初期化
  const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY || "");
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  // ==========================================
  // 2. 起動時にSupabaseから過去のデータを自動読み込み
  // ==========================================
  useEffect(() => {
    fetchBudgetData();
  }, []);

  // AIの回答が更新されたら、買い物リストをパースする
  useEffect(() => {
    if (!aiResponse) {
      setShoppingSections([]);
      return;
    }

    const parts = aiResponse.split(/##\s*🛒\s*買い物リスト/i);
    if (parts.length < 2) {
      setShoppingSections([]);
      return;
    }
    
    const shoppingText = parts[1];
    const lines = shoppingText.split('\n');
    
    const parsedSections: ShoppingSection[] = [];
    let currentSection = "";
    let lastSectionIndex = -1;

    lines.forEach((line, lineIdx) => {
      let trimmed = line.trim();
      if (!trimmed) return;

      // 買い物リストタブの中では応援メッセージの手前でパースを止める
      if (trimmed.includes("だいちゃんへ") || trimmed.includes("応援メッセージ")) {
        return;
      }

      const isHeader = 
        trimmed.startsWith('###') || 
        trimmed.startsWith('##') || 
        (trimmed.startsWith('**') && trimmed.endsWith('**') && (trimmed.includes('【') || trimmed.includes('類')));

      if (isHeader) {
        currentSection = trimmed.replace(/###|##|\*\*/g, '').trim();
        parsedSections.push({ title: currentSection, items: [] });
        lastSectionIndex = parsedSections.length - 1;
      } else if (trimmed.startsWith('*') || trimmed.startsWith('-')) {
        const itemText = trimmed.replace(/^[\*\-\s]+/, '').trim();
        if (lastSectionIndex >= 0) {
          parsedSections[lastSectionIndex].items.push({
            id: `item-${lastSectionIndex}-${lineIdx}`,
            name: itemText,
            checked: false
          });
        }
      } else {
        if (lastSectionIndex >= 0) {
          if (trimmed.length < 15 && !trimmed.startsWith('両親') && !trimmed.startsWith('この献立')) {
            parsedSections[lastSectionIndex].items.push({
              id: `item-${lastSectionIndex}-${lineIdx}`,
              name: trimmed,
              checked: false
            });
          }
        }
      }
    });

    const filteredSections = parsedSections.filter(sec => sec.items.length > 0);
    setShoppingSections(filteredSections);
  }, [aiResponse]);

  const fetchBudgetData = async () => {
    try {
      const { data, error } = await supabase
        .from('budgets')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error("データ取得エラー:", error);
        return;
      }

      if (data && data.length > 0) {
        setBudget(data[0].budget_amount);
        
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
    } catch (e) {
      console.error("データ取得中に例外発生:", e);
    }
  };

  // 出費を記録
  const addExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const price = parseInt(expense);
    const name = itemName || "買い物";

    if (isNaN(price) || price <= 0) {
      alert("金額を正しく入力してね！");
      return;
    }

    const newBudget = budget - price;

    try {
      const { error } = await supabase
        .from('budgets')
        .insert([{
          budget_amount: newBudget,
          item_name: name,
          expense_price: price,
          stock_items: stock,
          user_request: userRequest,
          ai_response: aiResponse
        }]);

      if (error) {
        alert("Supabaseへの保存に失敗しました: " + error.message);
        return;
      }

      setBudget(newBudget);
      await fetchBudgetData();
      setExpense("");
      setItemName("");

    } catch (err) {
      console.error("プログラム実行中に重大なエラー:", err);
    }
  };

  // データリセット
  const resetData = async () => {
    if (confirm("データをリセットして、今月の予算を¥25,000に戻しますか？（過去のデータはすべて消去されます）")) {
      const { error } = await supabase
        .from('budgets')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (error) {
        alert("リセットに失敗しました: " + error.message);
        return;
      }

      setBudget(25000);
      setAiResponse("");
      setHistory([]);
      setStock("");
    }
  };

  // Gemini相談
  const askGemini = async () => {
    setLoading(true);
    try {
      const prompt = `あなたは社会人の味方であり、コスパとタイパ（タイムパフォーマンス）を極めた節約料理のプロです。
      今回は【1週間分の買い出し金額の目安を「3500円程度」】にキッチリ収めた、最高に効率的な献立を提案してください。
      
      【だいちゃんの状況】
      ・平日は仕事で忙しく、帰宅後に時間をかけずにサクッと作れる「爆速・時短・簡単レシピ（10〜15分で作れるもの）」を求めています。
      ・冷蔵庫に余っている食材：${stock || "特になし"}
      ・追加のリクエスト：「${userRequest}」
      
      【出力のルール】
      1. 献立は、平日の夜の負担を極限まで減らす工夫を取り入れた1週間分を提案してください。
      2. 買い物リストのセクションの始まりには、必ず「## 🛒 買い物リスト」という見出しを書いてください。
      3. 不足している食材を、買いまわりしやすいように「### 【肉・魚類】」「### 【野菜類】」などのカテゴリ別の箇条書き（「- 食材名」形式）で綺麗に出力してください。
      4. 最後に、仕事を頑張るだいちゃんへの温かい応援メッセージを添えて、見やすいマークダウン形式で回答してね。`;
      
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      setAiResponse(text);
      setActiveTab('menu'); 

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

  // チェックON/OFF
  const toggleCheck = (sectionIdx: number, itemIdx: number) => {
    const updated = [...shoppingSections];
    updated[sectionIdx].items[itemIdx].checked = !updated[sectionIdx].items[itemIdx].checked;
    setShoppingSections(updated);
  };

  // 画面表示
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

        {/* 最近の履歴 */}
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
          <div className="bg-zinc-900 border border-cyan-900/30 rounded-3xl p-5 shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="text-cyan-400 font-bold mb-3 flex items-center gap-2 border-b border-zinc-800 pb-2">✨ Geminiの提案</div>
            
            <div className="flex gap-2 mb-4 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
              <button 
                type="button"
                onClick={() => setActiveTab('menu')}
                className={`flex-1 py-2 rounded-lg font-bold text-xs transition-all ${activeTab === 'menu' ? 'bg-cyan-600 text-white shadow' : 'text-gray-500 hover:text-gray-300'}`}
              >
                📅 1週間の献立
              </button>
              <button 
                type="button"
                onClick={() => setActiveTab('shopping')}
                className={`flex-1 py-2 rounded-lg font-bold text-xs transition-all ${activeTab === 'shopping' ? 'bg-cyan-600 text-white shadow' : 'text-gray-500 hover:text-gray-300'}`}
              >
                🛒 買い物リスト
              </button>
            </div>

            <div className="text-gray-300 text-sm leading-relaxed max-h-[400px] overflow-y-auto pr-1 font-light">
              {activeTab === 'menu' ? (
                // 🌟【修正箇所】献立タブでは、途中で切らずにGeminiの返答（応援メッセージ含む全文章）を丸ごと表示するよ！
                <div className="whitespace-pre-wrap">{aiResponse}</div>
              ) : (
                <div className="space-y-4">
                  {shoppingSections.map((sec, secIdx) => (
                    <div key={secIdx} className="border-b border-zinc-800/50 pb-3 last:border-0">
                      <h4 className="text-xs font-bold text-cyan-500 mb-2">{sec.title}</h4>
                      
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        {sec.items.map((item, itemIdx) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => toggleCheck(secIdx, itemIdx)}
                            className={`border rounded-lg px-2.5 py-2 text-left flex items-center gap-2 transition-all active:scale-95 ${
                              item.checked 
                                ? 'bg-zinc-900/20 border-zinc-800 text-gray-600 line-through decoration-zinc-700 decoration-1' 
                                : 'bg-zinc-950/60 border-zinc-800/40 text-gray-300 hover:border-zinc-700'
                            }`}
                          >
                            <div className={`w-3.5 h-3.5 rounded flex items-center justify-center border transition-all flex-shrink-0 ${
                              item.checked ? 'bg-cyan-900 border-cyan-600' : 'border-zinc-700 bg-zinc-900'
                            }`}>
                              {item.checked && <span className="text-[10px] text-cyan-400 font-bold">✓</span>}
                            </div>
                            <span className="truncate">{item.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {shoppingSections.length === 0 && (
                    <p className="text-xs text-gray-500">買い物リストを読み込み中...</p>
                  )}
                </div>
              )}
            </div>
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