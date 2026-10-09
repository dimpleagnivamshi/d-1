function currentFileName() {
    const path = window.location.pathname;
    const name = path.substring(path.lastIndexOf("/") + 1);
    if (name === "") return "index.html";
    return name;
}

function renderHeader() {
    const container = document.getElementById("pageHeader");
    if (!container) return;

    const activeFile = currentFileName();
    const page = PAGES.find(item => item.file === activeFile) || { title: document.title, description: "" };

    const header = document.createElement("div");
    header.className = "header";

    const heading = document.createElement("h1");
    heading.textContent = page.title;
    header.appendChild(heading);

    if (page.description) {
        const text = document.createElement("p");
        text.textContent = page.description;
        header.appendChild(text);
    }

    const nav = document.createElement("nav");
    nav.className = "nav";

    PAGES.forEach(item => {
        const link = document.createElement("a");
        link.href = item.file;
        link.textContent = item.title;
        if (item.file === activeFile) {
            link.className = "active";
        }
        nav.appendChild(link);
    });

    header.appendChild(nav);
    container.appendChild(header);
    document.title = page.title + " | Sensor Data Analysis";
}

renderHeader();