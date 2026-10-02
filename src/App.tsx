import "./styles.css";

const project = {
  "id": "hxwl-06",
  "port": 5106,
  "title": "显微镜玻片观察",
  "subtitle": "样本、多倍率视野与染色观察记录库",
  "stack": "React + Vite + TypeScript + CSS",
  "theme": [
    "#4338ca",
    "#0d9488",
    "#db2777"
  ],
  "domain": "生物显微观察",
  "users": [
    "实验课教师",
    "学生",
    "实验管理员"
  ],
  "metrics": [
    "样本数",
    "视野记录",
    "染色方法",
    "重点结构"
  ],
  "filters": [
    "植物组织",
    "动物组织",
    "微生物",
    "血液涂片"
  ],
  "fields": [
    "样本名称",
    "样本类型",
    "染色方式",
    "放大倍数",
    "观察结构",
    "视野描述"
  ],
  "records": [
    [
      "洋葱表皮",
      "植物组织",
      "碘液",
      "400x",
      "细胞壁清晰，细胞核可见"
    ],
    [
      "人血涂片",
      "血液涂片",
      "瑞氏染色",
      "1000x",
      "红细胞分布均匀"
    ],
    [
      "草履虫",
      "微生物",
      "活体观察",
      "200x",
      "纤毛运动明显"
    ]
  ]
};

const statusColors = ["status-ok", "status-watch", "status-danger"];

function MetricCard({ label, value, index }: { label: string; value: string; index: number }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={statusColors[index % statusColors.length]} />
    </article>
  );
}

function App() {
  const values = project.metrics.map((metric: string, index: number) => {
    const base = [84, 12, 31, 7][index % 4];
    return String(base + index * 3);
  });

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">{project.id} · port {project.port}</p>
          <h1>{project.title}</h1>
          <p className="subtitle">{project.subtitle}</p>
        </div>
        <div className="stack-card">
          <span>技术栈</span>
          <strong>{project.stack}</strong>
        </div>
      </section>

      <section className="metrics-grid">
        {project.metrics.map((metric: string, index: number) => (
          <MetricCard key={metric} label={metric} value={values[index]} index={index} />
        ))}
      </section>

      <section className="workspace">
        <aside className="panel narrow">
          <h2>角色</h2>
          <div className="chips">
            {project.users.map((user: string) => (
              <span key={user}>{user}</span>
            ))}
          </div>
          <h2>筛选</h2>
          <div className="chips muted">
            {project.filters.map((filter: string) => (
              <button key={filter}>{filter}</button>
            ))}
          </div>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>{project.domain}</p>
              <h2>记录字段</h2>
            </div>
            <button className="primary-action">新增记录</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="records panel">
        <div className="section-heading">
          <div>
            <p>示例数据</p>
            <h2>近期记录</h2>
          </div>
          <button>导出摘要</button>
        </div>
        <div className="record-list">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")} className="record-card">
              <div className="record-index">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
