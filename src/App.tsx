import React, { useEffect, useRef, useState } from 'react';
import {
  Mic,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Circle,
  Tag as TagIcon,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Lightbulb,
} from 'lucide-react';

type TaskTag = '生活/购物' | '本业工作' | '拉面店创业' | 'Web开发学习';

/** 统一条目：待办 (todo) 或 点子 (idea)，双流存储 */
type Task = {
  id: string;
  type: 'todo' | 'idea';
  text: string;
  tag?: TaskTag; // 仅 todo
  completed?: boolean; // 仅 todo
  createdAt: string;
};

const STORAGE_KEY = 'mind-dump-tasks-v2';

type SpeechRecognitionInstance = any;

function getDateKeyFromISO(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

function getDateKeyFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDateLabelFromKey(key: string): string {
  const d = new Date(key);
  return d.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

// 根据语音中的中文时间词，推测应该归档到哪一天
function getScheduledDateFromText(text: string): Date | null {
  const now = new Date();
  const content = text.replace(/\s+/g, '');

  // 相对日期：今天 / 明天 / 后天 / 大后天
  if (/大后天/.test(content)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 3);
    return d;
  }
  if (/后天/.test(content)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return d;
  }
  if (/(明天|明日)/.test(content)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (/(今天|今日|今儿)/.test(content)) {
    return now;
  }

  // 绝对日期：x号 / x日（默认当前或下一个月）
  const dayMatch = content.match(/(\d{1,2})[号日]/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    if (day >= 1 && day <= 31) {
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        // 如果这个日期已经过去，认为是下个月的同一天
        return new Date(now.getFullYear(), now.getMonth() + 1, day);
      }
      return d;
    }
  }

  // 星期几 / 周几：本周或下周
  const weekMatch = content.match(/(下周|下星期|这周|本周|本星期|周|星期)([一二三四五六天日])/);
  if (weekMatch) {
    const when = weekMatch[1];
    const dayChar = weekMatch[2];
    const map: Record<string, number> = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      日: 7,
      天: 7,
    };
    const targetWeekday = map[dayChar];
    if (targetWeekday) {
      // 当前星期几：周一=1，周日=7
      const currentWeekday = now.getDay() === 0 ? 7 : now.getDay();
      let diff = targetWeekday - currentWeekday;
      // 本周内还没到就用本周，否则推到下周
      if (diff < 0) diff += 7;
      // 带“下周/下星期”则在此基础上再往后推一周
      if (/下周|下星期/.test(when)) {
        diff += 7;
      }
      const d = new Date(now);
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  return null;
}

// 将任务里的日期描述删掉，避免在未来某天读到“下周五”产生歧义
function stripDateWords(text: string): string {
  let result = text;
  const patterns: RegExp[] = [
    /(今天|今日|今儿)/g,
    /(明天|明日)/g,
    /后天/g,
    /大后天/g,
    /(本周|这周|本星期|下周|下星期)/g,
    /周[一二三四五六天日]/g,
    /星期[一二三四五六天日]/g,
    /\d{1,2}月\d{1,2}[号日]?/g,
    /\d{1,2}月/g,
    /\d{1,2}[号日]/g,
  ];
  for (const p of patterns) {
    result = result.replace(p, '');
  }
  // 压缩多余空格
  result = result.replace(/\s{2,}/g, ' ');
  return result.trim();
}

function loadTasks(): Task[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // 兼容旧版 v1 数据
      const v1 = window.localStorage.getItem('mind-dump-tasks-v1');
      if (!v1) return [];
      const parsed = JSON.parse(v1) as Array<Record<string, unknown>>;
      const migrated: Task[] = parsed.map((t) => ({
        id: String(t.id),
        type: (t.type as 'todo' | 'idea') || 'todo',
        text: String(t.text),
        tag: t.tag as TaskTag | undefined,
        completed: t.completed as boolean | undefined,
        createdAt: String(t.createdAt),
      }));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return parsed.map((t) => ({
      id: String(t.id),
      type: (t.type === 'idea' ? 'idea' : 'todo') as 'todo' | 'idea',
      text: String(t.text),
      tag: t.tag as TaskTag | undefined,
      completed: t.completed as boolean | undefined,
      createdAt: String(t.createdAt),
    }));
  } catch {
    return [];
  }
}

function saveTasks(tasks: Task[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // ignore
  }
}

// 将转录文本拆分成多条任务并打标签，并根据语音里的时间词决定归档日期
function processTranscriptToTasks(text: string): Task[] {
  const now = new Date();
  const scheduled = getScheduledDateFromText(text);
  const base = scheduled ?? now;
  const baseISO = base.toISOString();

  const rawItems = text
    .split(/[,，。；;、]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const cleanedItems = rawItems
    .map((item) => stripDateWords(item))
    .map((s) => s.trim())
    .filter(Boolean);

  if (cleanedItems.length === 0) {
    return [
      {
        id: `${baseISO}-0`,
        type: 'todo' as const,
        text: stripDateWords(text).trim() || text.trim(),
        tag: '本业工作',
        completed: false,
        createdAt: baseISO,
      },
    ];
  }

  const classify = (content: string): TaskTag => {
    const lower = content.toLowerCase();

    const isRamen =
      /拉面|汤底|高汤|面条|店铺|选址|租金|装修|门店|开店|创业|财务|成本|利润/.test(content);
    if (isRamen) return '拉面店创业';

    const isWeb =
      /react|javascript|typescript|前端|css|html|node|web|编程|代码|教程|学习|vite/.test(
        lower + content,
      );
    if (isWeb) return 'Web开发学习';

    const isWork = /报告|邮件|同事|会议|客户|项目|排期|需求|上线|测试|bug|OKR|周报|工作/.test(
      content,
    );
    if (isWork) return '本业工作';

    const isLife =
      /买|购买|购物|超市|菜市场|支付|家务|打扫|整理|洗衣|做饭|吃饭|晚餐|午餐|早餐|外卖|预约/.test(
        content,
      );
    if (isLife) return '生活/购物';

    // 默认归为“本业工作”，你可以根据习惯调整
    return '本业工作';
  };

  return cleanedItems.map((item, index) => ({
    id: `${baseISO}-${index}`,
    type: 'todo' as const,
    text: item,
    tag: classify(item),
    completed: false,
    createdAt: baseISO,
  }));
}

type UserTag = {
  id: string;
  label: string;
  builtin?: boolean;
};

const DEFAULT_TAGS: UserTag[] = [
  { id: 'life', label: '生活/购物', builtin: true },
  { id: 'work', label: '本业工作', builtin: true },
  { id: 'ramen', label: '拉面店创业', builtin: true },
  { id: 'webdev', label: 'Web开发学习', builtin: true },
];

const TAGS_STORAGE_KEY = 'mind-dump-user-tags-v1';

function loadUserTags(): UserTag[] {
  if (typeof window === 'undefined') return DEFAULT_TAGS;
  try {
    const raw = window.localStorage.getItem(TAGS_STORAGE_KEY);
    if (!raw) return DEFAULT_TAGS;
    const parsed = JSON.parse(raw) as UserTag[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_TAGS;
    return parsed;
  } catch {
    return DEFAULT_TAGS;
  }
}

function saveUserTags(tags: UserTag[]) {
  try {
    window.localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(tags));
  } catch {
    // ignore
  }
}

type TagEditorProps = {
  userTags: UserTag[];
  setUserTags: React.Dispatch<React.SetStateAction<UserTag[]>>;
};

const TagEditor: React.FC<TagEditorProps> = ({ userTags, setUserTags }) => {
  const [input, setInput] = useState('');

  const handleAdd = () => {
    const label = input.trim();
    if (!label) return;
    if (userTags.some((t) => t.label === label)) {
      setInput('');
      return;
    }
    if (userTags.length >= 12) {
      return;
    }
    const id = `custom-${Date.now()}`;
    setUserTags([...userTags, { id, label }]);
    setInput('');
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={input}
        maxLength={12}
        onChange={(e) => setInput(e.target.value)}
        className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
        placeholder="例如：健身、写作、家庭"
      />
      <button
        type="button"
        onClick={handleAdd}
        className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-50"
      >
        添加
      </button>
    </div>
  );
};

const App: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string>('按住按钮，说出你脑中的一切。');

  const [activeTab, setActiveTab] = useState<
    'record' | 'today' | 'ideas' | 'calendar' | 'profile'
  >('record');
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDateKey, setSelectedDateKey] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });

  const [userTags, setUserTags] = useState<UserTag[]>(() => loadUserTags());
  const [pendingTasks, setPendingTasks] = useState<Task[] | null>(null);
  const [profileName, setProfileName] = useState<string>(() => {
    if (typeof window === 'undefined') return 'Mind Dumper';
    try {
      return window.localStorage.getItem('mind-dump-profile-name') || 'Mind Dumper';
    } catch {
      return 'Mind Dumper';
    }
  });

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const transcriptRef = useRef<string>('');
  const isPointerDownRef = useRef(false);

  useEffect(() => {
    setTasks(loadTasks());
  }, []);

  useEffect(() => {
    saveTasks(tasks);
  }, [tasks]);

  useEffect(() => {
    saveUserTags(userTags);
  }, [userTags]);

  const getSpeechRecognitionCtor = (): SpeechRecognitionInstance | null => {
    if (typeof window === 'undefined') return null;
    const w = window as any;
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  };

  const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);

  const getSpeechErrorMessage = (eventError: string | undefined): string => {
    const err = (eventError || '').toLowerCase();
    if (err === 'not-allowed') return '请允许麦克风权限后重试。';
    if (err === 'no-speech') return '未检测到语音，请靠近麦克风再说一遍。';
    if (err === 'network') return '网络问题，请检查网络后重试。';
    if (err === 'audio-capture') return '无法使用麦克风，请检查设备权限。';
    if (err === 'aborted') return '录音已取消。';
    if (isIOS) {
      return '当前设备上语音识别可能不可用，建议用电脑或安卓手机的 Chrome 打开本页面。';
    }
    return '语音识别出错，请稍后重试或更换为 Chrome / Edge 浏览器。';
  };

  const startRecording = async () => {
    if (isRecording || isProcessing || (pendingTasks && pendingTasks.length > 0)) return;
    setError(null);
    setHint('正在录音中，说就对了。');

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError('当前浏览器暂不支持原生语音识别，请使用最新版 Chrome 或 Edge 再试。');
      setHint('在支持 Web Speech API 的浏览器中打开效果最佳。');
      return;
    }

    try {
      const recognition: SpeechRecognitionInstance = new Ctor();
      recognitionRef.current = recognition;
      transcriptRef.current = '';

      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event: any) => {
        // 只累积「最终结果」，并覆盖之前的内容，避免同一段话被重复追加很多遍
        let finalTranscript = '';
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            finalTranscript += result[0].transcript;
          }
        }
        transcriptRef.current = finalTranscript;
      };

      recognition.onerror = (event: any) => {
        console.error(event);
        const msg = getSpeechErrorMessage(event?.error);
        setError(msg);
        setHint(isIOS ? '建议用电脑或安卓 Chrome 打开本页面使用语音功能。' : '可以重新按住按钮，再说一遍。');
        setIsRecording(false);
        setIsProcessing(false);
        recognitionRef.current = null;
      };

      recognition.onend = () => {
        // 录音结束后进行文本处理
        const finalText = transcriptRef.current.trim();
        recognitionRef.current = null;

        if (!finalText) {
          setHint('没有捕捉到清晰的语音，可以稍微说长一点再试。');
          setIsProcessing(false);
          setIsRecording(false);
          return;
        }

        setIsProcessing(true);
        setHint('正在转文字并按标签整理任务…');
        try {
          const newTasks = processTranscriptToTasks(finalText);
          setPendingTasks(newTasks);
          setHint('已识别出任务，请为每条选择合适的标签。');
        } catch (e) {
          console.error(e);
          setError('处理转录文本时出错，请稍后重试。');
          setHint('可以重新按住按钮，再说一遍。');
        } finally {
          transcriptRef.current = '';
          setIsProcessing(false);
          setIsRecording(false);
        }
      };

      recognition.start();
      setIsRecording(true);
    } catch (e) {
      console.error(e);
      setError('启动语音识别失败，请检查浏览器设置或尝试更换浏览器。');
      setHint('建议在桌面或移动端 Chrome 中打开。');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (!isRecording) return;
    setHint('正在结束录音…');
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        console.error(e);
        setIsRecording(false);
      }
    } else {
      setIsRecording(false);
    }
  };

  const handlePointerDown: React.PointerEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    if (e.button !== 0 && e.pointerType === 'mouse') return; // 只处理左键
    isPointerDownRef.current = true;
    startRecording();
  };

  const handlePointerUp: React.PointerEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    if (!isPointerDownRef.current) return;
    isPointerDownRef.current = false;
    stopRecording();
  };

  const toggleTask = (id: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id && t.type === 'todo'
          ? { ...t, completed: !(t.completed ?? false) }
          : t
      ),
    );
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const todos = tasks.filter((t) => t.type === 'todo');
  const ideas = tasks.filter((t) => t.type === 'idea');
  const hasTasks = tasks.length > 0;

  const todayKey = new Date().toISOString().slice(0, 10);
  const tasksForToday = todos.filter((t) => getDateKeyFromISO(t.createdAt) === todayKey);
  const tasksForSelectedDate = todos.filter(
    (t) => getDateKeyFromISO(t.createdAt) === selectedDateKey,
  );
  const dateKeysWithTasks = new Set<string>();
  todos.forEach((t) => dateKeysWithTasks.add(getDateKeyFromISO(t.createdAt)));

  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = (firstDay.getDay() + 6) % 7; // 将周一作为一周的第一天
  const calendarCells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) {
    calendarCells.push(null);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    calendarCells.push(new Date(year, month, d));
  }

  const handleChangePendingTag = (taskId: string, tagLabel: string) => {
    setPendingTasks((prev) =>
      prev ? prev.map((t) => (t.id === taskId ? { ...t, tag: tagLabel as TaskTag } : t)) : prev
    );
  };

  /** 将某条待确认项设为「待办」或「点子」 */
  const handleSetPendingType = (taskId: string, type: 'todo' | 'idea') => {
    setPendingTasks((prev) => {
      if (!prev) return prev;
      return prev.map((t) => {
        if (t.id !== taskId) return t;
        if (type === 'todo') {
          return { ...t, type: 'todo' as const, tag: (t.tag ?? '本业工作') as TaskTag, completed: false };
        }
        return { ...t, type: 'idea' as const, tag: undefined, completed: undefined };
      });
    });
  };

  const handleConfirmPendingTasks = () => {
    if (!pendingTasks || pendingTasks.length === 0) return;
    const toSave: Task[] = pendingTasks.map((t) => {
      if (t.type === 'idea') {
        return { id: t.id, type: 'idea', text: t.text, createdAt: t.createdAt };
      }
      return {
        id: t.id,
        type: 'todo',
        text: t.text,
        tag: t.tag ?? '本业工作',
        completed: false,
        createdAt: t.createdAt,
      };
    });
    setTasks((prev) => [...toSave, ...prev]);
    setPendingTasks(null);
    const todoCount = toSave.filter((t) => t.type === 'todo').length;
    const ideaCount = toSave.filter((t) => t.type === 'idea').length;
    if (ideaCount > 0 && todoCount > 0) {
      setHint('已保存：待办在“今日待办/日历”，点子在“灵感库”查看。');
    } else if (ideaCount > 0) {
      setHint('已存为点子，可在“灵感库”查看。');
    } else {
      setHint('已保存到任务列表，可在“今日待办”和“日历”中查看。');
    }
  };

  const handleDiscardPendingTasks = () => {
    setPendingTasks(null);
    setHint('这次识别的任务已丢弃，如有需要可以重新录一段。');
  };

  return (
    <div className="min-h-screen flex flex-col bg-mind-bg text-mind-text">
      <main className="flex-1 flex flex-col items-center justify-center px-6 pb-32 pt-16">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight">Mind Dump</h1>
            <p className="text-sm text-slate-600 leading-relaxed">
              打开就能说。按住中间的按钮，把脑子里的“杂念”一次性倒出来，
              我来帮你整理成可执行的待办。
            </p>
          </div>

          {activeTab === 'record' && (
            <div className="flex flex-col items-center gap-4">
              <button
                type="button"
                className={[
                  'relative h-40 w-40 rounded-full flex items-center justify-center',
                  'bg-white shadow-lg border border-slate-200',
                  'transition-transform duration-200 ease-out',
                  'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-300',
                  'touch-none select-none',
                  !isProcessing && 'animate-pulse-soft',
                  isRecording && 'scale-105',
                  isProcessing && 'opacity-80 pointer-events-none',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onPointerLeave={(e) => {
                  if (isPointerDownRef.current) {
                    handlePointerUp(e as any);
                  }
                }}
              >
                <div
                  className={[
                    'h-24 w-24 rounded-full flex items-center justify-center',
                    'bg-slate-900 text-white shadow-md',
                    'transition-all duration-200',
                    isRecording ? 'bg-red-500' : 'bg-slate-900',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {isProcessing ? (
                    <Loader2 className="h-8 w-8 animate-spin" />
                  ) : (
                    <Mic className="h-9 w-9" />
                  )}
                </div>
              </button>

              <div className="space-y-1">
                <p className="text-sm font-medium text-slate-700">
                  {isRecording
                    ? '录音中… 松开手指即可结束'
                    : isProcessing
                    ? '处理中，请稍候'
                    : '按住按钮，说出你的想法'}
                </p>
                <p className="text-xs text-slate-500">{hint}</p>
              </div>

              {error && (
                <div className="mt-2 inline-flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-left">
                  <AlertCircle className="h-4 w-4 text-red-500 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-red-700">录音或处理出错</p>
                    <p className="text-xs text-red-600">{error}</p>
                  </div>
                </div>
              )}

              <p className="text-[11px] text-slate-400 mt-1">
                语音功能推荐：电脑 Chrome、安卓 Chrome；iPhone 上可能无法使用。
              </p>
            </div>
          )}

          {activeTab === 'today' && (
            <div className="text-left space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ListChecks className="h-4 w-4 text-slate-500" />
                  <p className="text-xs font-medium text-slate-600 uppercase tracking-[0.16em]">
                    今日待办
                  </p>
                </div>
                <span className="text-[11px] text-slate-400">
                  {tasksForToday.length > 0
                    ? `今天共有 ${tasksForToday.length} 条任务`
                    : '今天还没有任务'}
                </span>
              </div>

              {tasksForToday.length === 0 ? (
                <p className="text-xs text-slate-400">
                  切换到底部的“录音”标签，说出你的想法，今天的任务就会出现在这里。
                </p>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1 text-left">
                  {tasksForToday.map((task) => (
                    <article
                      key={task.id}
                      className="flex items-start gap-3 rounded-2xl border border-slate-100 bg-slate-50/80 px-3 py-2.5"
                    >
                      <button
                        type="button"
                        onClick={() => toggleTask(task.id)}
                        className="mt-0.5 text-slate-500 hover:text-slate-900 transition-colors"
                      >
                        {task.completed ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                        ) : (
                          <Circle className="h-5 w-5" />
                        )}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p
                          className={[
                            'text-sm',
                            task.completed ? 'line-through text-slate-400' : 'text-slate-800',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {task.text}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center rounded-full bg-slate-900 text-[10px] font-medium text-slate-50 px-2 py-0.5">
                            {task.tag ?? '未分类'}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {formatTime(task.createdAt)}
                          </span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'ideas' && (
            <div className="text-left space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-amber-500" />
                  <p className="text-xs font-medium text-slate-600 uppercase tracking-[0.16em]">
                    灵感库
                  </p>
                </div>
                <span className="text-[11px] text-slate-400">
                  {ideas.length > 0 ? `共 ${ideas.length} 条` : '暂无点子'}
                </span>
              </div>

              {ideas.length === 0 ? (
                <p className="text-xs text-slate-400">
                  录音结束后，在弹窗里选择「转化为点子」即可把灵感存到这里。
                </p>
              ) : (
                <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                  {ideas.map((idea) => (
                    <article
                      key={idea.id}
                      className="rounded-2xl border-l-4 border-amber-400/80 bg-amber-50/60 px-3 py-2.5 shadow-sm"
                    >
                      <p className="text-sm text-slate-800">{idea.text}</p>
                      <span className="mt-1 block text-[10px] text-slate-400">
                        {formatTime(idea.createdAt)}
                      </span>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'calendar' && (
            <div className="text-left space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-slate-500" />
                  <p className="text-xs font-medium text-slate-600 uppercase tracking-[0.16em]">
                    日历视图
                  </p>
                </div>
                <div className="flex items-center gap-1 text-xs text-slate-500">
                  <button
                    type="button"
                    aria-label="上一月"
                    className="p-1 rounded-full hover:bg-slate-100"
                    onClick={() =>
                      setCalendarMonth((prev) => {
                        return new Date(prev.getFullYear(), prev.getMonth() - 1, 1);
                      })
                    }
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="px-1">
                    {calendarMonth.toLocaleDateString('zh-CN', {
                      year: 'numeric',
                      month: 'long',
                    })}
                  </span>
                  <button
                    type="button"
                    aria-label="下一月"
                    className="p-1 rounded-full hover:bg-slate-100"
                    onClick={() =>
                      setCalendarMonth((prev) => {
                        return new Date(prev.getFullYear(), prev.getMonth() + 1, 1);
                      })
                    }
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-3">
                <div className="grid grid-cols-7 gap-1 text-[11px] text-slate-400 mb-1">
                  {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
                    <div key={d} className="h-6 flex items-center justify-center">
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1 text-sm">
                  {calendarCells.map((date, index) => {
                    if (!date) {
                      return <div key={`empty-${index}`} className="h-9" />;
                    }
                    const key = getDateKeyFromDate(date);
                    const isToday = key === todayKey;
                    const isSelected = key === selectedDateKey;
                    const hasTask = dateKeysWithTasks.has(key);

                    const base =
                      'h-9 flex flex-col items-center justify-center rounded-full text-xs cursor-pointer select-none';
                    const variant = isSelected
                      ? 'bg-slate-900 text-white'
                      : isToday
                      ? 'border border-slate-900/40 text-slate-900'
                      : 'text-slate-600 hover:bg-slate-100';

                    return (
                      <button
                        key={key}
                        type="button"
                        className={`${base} ${variant}`}
                        onClick={() => setSelectedDateKey(key)}
                      >
                        <span>{date.getDate()}</span>
                        {hasTask && (
                          <span
                            className={[
                              'mt-0.5 rounded-full',
                              'w-1.5 h-1.5',
                              isSelected ? 'bg-emerald-300' : 'bg-emerald-400/80',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs text-slate-500">
                  {formatDateLabelFromKey(selectedDateKey)} ·{' '}
                  {tasksForSelectedDate.length > 0
                    ? `共 ${tasksForSelectedDate.length} 条任务`
                    : '这一天暂时还没有任务'}
                </p>

                {tasksForSelectedDate.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    回到“录音”标签，说出你的想法，系统会自动把当天的内容归档到这里。
                  </p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {tasksForSelectedDate.map((task) => (
                      <article
                        key={task.id}
                        className="flex items-start gap-3 rounded-2xl border border-slate-100 bg-slate-50/80 px-3 py-2.5"
                      >
                        <button
                          type="button"
                          onClick={() => toggleTask(task.id)}
                          className="mt-0.5 text-slate-500 hover:text-slate-900 transition-colors"
                        >
                          {task.completed ? (
                            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                          ) : (
                            <Circle className="h-5 w-5" />
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <p
                            className={[
                              'text-sm',
                              task.completed ? 'line-through text-slate-400' : 'text-slate-800',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            {task.text}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center rounded-full bg-slate-900 text-[10px] font-medium text-slate-50 px-2 py-0.5">
                              {task.tag ?? '未分类'}
                            </span>
                            <span className="text-[10px] text-slate-400">
                              {formatTime(task.createdAt)}
                            </span>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'profile' && (
            <div className="text-left space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-600 uppercase tracking-[0.16em]">
                    个人主页
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-slate-900">
                    嗨，{profileName || 'Mind Dumper'}
                  </h2>
                </div>
              </div>

              {/* 昵称设置 */}
              <div className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-3 space-y-2">
                <p className="text-xs font-medium text-slate-700">称呼</p>
                <input
                  type="text"
                  value={profileName}
                  maxLength={16}
                  onChange={(e) => {
                    const value = e.target.value;
                    setProfileName(value);
                    try {
                      window.localStorage.setItem('mind-dump-profile-name', value);
                    } catch {
                      // ignore
                    }
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
                  placeholder="怎么称呼你？"
                />
                <p className="text-[11px] text-slate-400">
                  只保存在本机，不会上传到任何服务器。
                </p>
              </div>

              {/* 自定义标签管理 */}
              <div className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-3 space-y-3">
                <p className="text-xs font-medium text-slate-700">任务标签</p>
                <p className="text-[11px] text-slate-400">
                  这些标签会出现在录音结束后的“分配标签”界面，你可以根据自己的生活来增加或精简。
                </p>
                <div className="flex flex-wrap gap-2">
                  {userTags.map((tag) => (
                    <span
                      key={tag.id}
                      className="inline-flex items-center gap-1 rounded-full bg-slate-900 text-[11px] font-medium text-slate-50 px-2.5 py-1"
                    >
                      {tag.label}
                      <button
                        type="button"
                        onClick={() => {
                          const next = window.prompt('修改标签名称', tag.label);
                          const trimmed = next?.trim();
                          if (!trimmed || trimmed === tag.label) return;
                          setUserTags((prev) =>
                            prev.map((t) => (t.id === tag.id ? { ...t, label: trimmed } : t)),
                          );
                        }}
                        className="ml-0.5 text-slate-300 hover:text-slate-100"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setUserTags((prev) => {
                            if (prev.length <= 1) return prev;
                            return prev.filter((t) => t.id !== tag.id);
                          })
                        }
                        className="ml-0.5 text-slate-300 hover:text-red-200"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>

                <TagEditor userTags={userTags} setUserTags={setUserTags} />
              </div>

              {/* 简单统计 */}
              <div className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-3 space-y-2">
                <p className="text-xs font-medium text-slate-700">使用统计（仅本机）</p>
                <p className="text-[11px] text-slate-400">
                  待办 {todos.length} 条 · 已完成 {todos.filter((t) => t.completed).length} 条 · 点子{' '}
                  {ideas.length} 条
                </p>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 底部滑出的待办列表，仅在录音 Tab 且有待办时显示 */}
      {activeTab === 'record' && (
        <section
          className={[
            'fixed inset-x-0 bottom-16',
            'transition-transform duration-400 ease-out',
            todos.length > 0 ? 'translate-y-0' : 'translate-y-full',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div className="mx-auto max-w-md">
            <div className="rounded-t-3xl bg-white/95 backdrop-blur border-t border-slate-200 shadow-[0_-8px_30px_rgba(15,23,42,0.15)] px-4 pt-3 pb-6">
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" />

              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <TagIcon className="h-4 w-4 text-slate-500" />
                  <p className="text-xs font-medium text-slate-600 uppercase tracking-[0.16em]">
                    捕捉到的待办
                  </p>
                </div>
                {todos.length > 0 && (
                  <span className="text-[11px] text-slate-400">
                    共 {todos.length} 条 · 轻点左侧圆圈即可勾选
                  </span>
                )}
              </div>

              {todos.length === 0 ? (
                <p className="text-xs text-slate-400">
                  录音结束后，选择「待办」的会出现在这里；点子请到「灵感库」查看。
                </p>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {todos.map((task) => (
                    <article
                      key={task.id}
                      className="flex items-start gap-3 rounded-2xl border border-slate-100 bg-slate-50/80 px-3 py-2.5"
                    >
                      <button
                        type="button"
                        onClick={() => toggleTask(task.id)}
                        className="mt-0.5 text-slate-500 hover:text-slate-900 transition-colors"
                      >
                        {task.completed ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                        ) : (
                          <Circle className="h-5 w-5" />
                        )}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p
                          className={[
                            'text-sm',
                            task.completed ? 'line-through text-slate-400' : 'text-slate-800',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {task.text}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center rounded-full bg-slate-900 text-[10px] font-medium text-slate-50 px-2 py-0.5">
                            {task.tag ?? '未分类'}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {formatTime(task.createdAt)}
                          </span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* 底部 Tab 导航栏（5 Tab：录音、今日待办、灵感库、日历、我的） */}
      <nav className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 backdrop-blur shadow-[0_-4px_20px_rgba(15,23,42,0.08)]">
        <div className="mx-auto max-w-md flex items-stretch justify-around h-16">
          <button
            type="button"
            onClick={() => setActiveTab('record')}
            className={[
              'flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] min-w-0',
              activeTab === 'record' ? 'text-slate-900' : 'text-slate-400',
            ].join(' ')}
          >
            <Mic className="h-5 w-5 shrink-0" />
            <span>录音</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('today')}
            className={[
              'flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] min-w-0',
              activeTab === 'today' ? 'text-slate-900' : 'text-slate-400',
            ].join(' ')}
          >
            <ListChecks className="h-5 w-5 shrink-0" />
            <span>今日待办</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('ideas')}
            className={[
              'flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] min-w-0',
              activeTab === 'ideas' ? 'text-amber-600' : 'text-slate-400',
            ].join(' ')}
          >
            <Lightbulb className="h-5 w-5 shrink-0" />
            <span>灵感库</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('calendar')}
            className={[
              'flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] min-w-0',
              activeTab === 'calendar' ? 'text-slate-900' : 'text-slate-400',
            ].join(' ')}
          >
            <CalendarDays className="h-5 w-5 shrink-0" />
            <span>日历</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            className={[
              'flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] min-w-0',
              activeTab === 'profile' ? 'text-slate-900' : 'text-slate-400',
            ].join(' ')}
          >
            <TagIcon className="h-5 w-5 shrink-0" />
            <span>我的</span>
          </button>
        </div>
      </nav>

      {/* 录音后：每条可选「待办」或「点子」，待办再选标签 */}
      {pendingTasks && pendingTasks.length > 0 && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-t-3xl bg-white px-4 pt-3 pb-4">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" />
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-medium text-slate-700 uppercase tracking-[0.16em]">
                存为待办或点子
              </p>
              <span className="text-[11px] text-slate-400">
                共 {pendingTasks.length} 条
              </span>
            </div>
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {pendingTasks.map((task) => (
                <article
                  key={task.id}
                  className={
                    task.type === 'idea'
                      ? 'rounded-2xl border-l-4 border-amber-400/80 bg-amber-50/60 px-3 py-2.5 text-left'
                      : 'rounded-2xl border border-slate-100 bg-slate-50/80 px-3 py-2.5 text-left'
                  }
                >
                  <p className="text-sm text-slate-800">{task.text}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-slate-500">存为：</span>
                    <button
                      type="button"
                      onClick={() => handleSetPendingType(task.id, 'todo')}
                      className={[
                        'px-2 py-0.5 rounded-full text-[11px] border',
                        task.type === 'todo'
                          ? 'bg-slate-900 text-slate-50 border-slate-900'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400',
                      ].join(' ')}
                    >
                      待办
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetPendingType(task.id, 'idea')}
                      className={[
                        'px-2 py-0.5 rounded-full text-[11px] border',
                        task.type === 'idea'
                          ? 'bg-amber-500 text-white border-amber-500'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-amber-300',
                      ].join(' ')}
                    >
                      点子
                    </button>
                  </div>
                  {task.type === 'todo' && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {userTags.map((tag) => {
                        const isActive = task.tag === tag.label;
                        return (
                          <button
                            key={tag.id}
                            type="button"
                            onClick={() => handleChangePendingTag(task.id, tag.label)}
                            className={[
                              'px-2 py-0.5 rounded-full text-[11px] border',
                              isActive
                                ? 'bg-slate-900 text-slate-50 border-slate-900'
                                : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400',
                            ].join(' ')}
                          >
                            {tag.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </article>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={handleDiscardPendingTasks}
                className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600"
              >
                丢弃
              </button>
              <button
                type="button"
                onClick={handleConfirmPendingTasks}
                className="flex-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-medium text-slate-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;

