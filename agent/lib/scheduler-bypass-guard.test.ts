/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Таблицы гварда T2: что блокируется до exec и что обязано проходить. Стиль — как у
// self-restart-guard.test.ts: хелперы печатают саму команду, по одному test() на правило.
import { strict as assert } from "node:assert";
import test from "node:test";
import { schedulerBypassViolation } from "./scheduler-bypass-guard.ts";

const blocked = (cmd: string) =>
  assert.notEqual(
    schedulerBypassViolation(cmd),
    null,
    `должна блокироваться: ${cmd}`,
  );
const allowed = (cmd: string) =>
  assert.equal(
    schedulerBypassViolation(cmd),
    null,
    `не должна блокироваться: ${cmd}`,
  );

test("R1: systemd-run в командной позиции блокируется в любой форме", () => {
  for (const cmd of [
    'systemd-run --user --on-calendar="10:00" iva remind "позвонить"',
    "systemd-run --user --on-calendar=10:00 /home/shima/.local/bin/iva remind x",
    "sudo systemd-run --user date",
    "bash -c 'systemd-run --user --on-calendar=10:00 iva notify x'",
    "nohup systemd-run --user true",
    "/usr/bin/systemd-run --user true",
  ]) {
    blocked(cmd);
  }
});

test("R2: crontab блокируется везде, кроме чтения через -l", () => {
  for (const cmd of [
    "crontab -",
    "crontab -e",
    "crontab -r",
    "crontab /tmp/cron.txt",
    "crontab",
    "crontab -u shima -",
    "sudo crontab -",
  ]) {
    blocked(cmd);
  }
});

test("R3: at и batch (отложенный запуск) блокируются", () => {
  for (const cmd of [
    "at now + 1 hour",
    "echo 'iva notify x' | at 09:00",
    "batch",
    "sudo at 09:00 -f ~/job.sh",
  ]) {
    blocked(cmd);
  }
});

test("R4: systemctl start/enable/--now чужого юнита блокируется", () => {
  for (const cmd of [
    "systemctl --user start remind.timer",
    "systemctl --user enable --now x.timer",
    "systemctl --user link ~/x.service",
    "systemctl --user restart remind.timer",
    "systemctl --user reenable remind.timer",
    "systemctl --user edit remind.timer",
    "systemctl --user restart iva-telegram-poll caddy.service",
  ]) {
    blocked(cmd);
  }
});

test("R5: запись в ~/.config/systemd/user блокируется", () => {
  for (const cmd of [
    "cat > ~/.config/systemd/user/x.timer <<EOF",
    "tee ~/.config/systemd/user/x.timer",
    "cp x.timer ~/.config/systemd/user/",
    "ln -s ~/x.timer ~/.config/systemd/user/x.timer",
    "install -m 0644 x.service ~/.config/systemd/user/x.service",
    "mkdir -p ~/.config/systemd/user",
    "rm ~/.config/systemd/user/x.timer",
    "printf '[Unit]\\n' > $HOME/.config/systemd/user/x.timer",
    "sed -i s/OnCalendar=x/OnCalendar=y/ ~/.config/systemd/user/x.timer",
    "bash -c 'echo x > ~/.config/systemd/user/x.timer'",
  ]) {
    blocked(cmd);
  }
});

test("R6: свой скрипт в ~/.iva-scripts блокируется", () => {
  for (const cmd of [
    "mkdir -p ~/.iva-scripts",
    "cat > ~/.iva-scripts/remind.sh <<EOF",
    "chmod +x ~/.iva-scripts/remind.sh",
    "bash ~/.iva-scripts/remind.sh",
    "~/.iva-scripts/remind.sh",
    "cp x.sh /home/shima/.iva-scripts/",
    "sudo bash -c 'chmod +x ~/.iva-scripts/remind.sh'",
  ]) {
    blocked(cmd);
  }
});

test("R7: прямой вызов api.telegram.org блокируется", () => {
  for (const cmd of [
    "curl -s https://api.telegram.org/bot$T/sendMessage -d text=hi",
    "wget -qO- https://api.telegram.org/bot$T/getMe",
    "http POST https://api.telegram.org/bot$T/sendMessage",
    "python3 -c \"urllib.request.urlopen('https://api.telegram.org/bot1/sendMessage')\"",
    "node -e \"fetch('https://api.telegram.org/bot1/sendMessage')\"",
    "TG=https://api.telegram.org; curl $TG/bot1/sendMessage",
    'echo "curl https://api.telegram.org/bot1/sendMessage" > send.sh',
    "curl https://api.telegram.org/bot$T/sendMessage && rm -f /tmp/x",
  ]) {
    blocked(cmd);
  }
});

test("R8: sleep как таймер перед следующей командой блокируется", () => {
  for (const cmd of [
    "sleep 3600 && iva notify x",
    "sleep 3600; iva notify x",
    "sleep 1h && iva remind x",
    "sleep 90 && curl https://example.com",
    "(sleep 3600; iva notify x) &",
    "while true; do sleep 3600; iva notify x; done",
    "sleep $DELAY && iva notify x",
    "sleep 30m 30s && iva notify x",
    // Форма, которой учит промпт: абсолютный путь через $HOME и присваивания впереди.
    "sleep 3600 && $HOME/.local/bin/iva notify x",
    "sleep 3600; $HOME/.local/bin/iva remind x",
    "sleep 1h && $HOME/.local/bin/iva remind x",
    "sleep 3600 && TZ=UTC iva notify x",
    "sleep 3600 && /usr/bin/env iva notify x",
    "while true; do sleep 3600; $HOME/.local/bin/iva notify x; done",
  ]) {
    blocked(cmd);
  }
});

test("обёртки, кавычки, подстановки и переносы строк не спасают", () => {
  for (const cmd of [
    '"systemd-run" --user true',
    "systemd-run --user --on-calendar='10:00' true",
    "sudo -n systemd-run --user true",
    "env FOO=1 systemd-run --user true",
    "timeout 5 systemd-run --user true",
    "nohup systemd-run --user true",
    "command systemd-run --user true",
    "exec systemd-run --user true",
    "nice systemd-run --user true",
    'bash -c "systemd-run --user true"',
    "sh -c 'crontab -'",
    "echo hi\nsystemd-run --user true",
    "$(systemd-run --user true)",
    "`crontab -`",
    "while :; do crontab -; done",
    "if true; then systemd-run --user true; fi",
  ]) {
    blocked(cmd);
  }
});

test("разрешённые: чтение, статус, упоминания в аргументах, короткий sleep", () => {
  for (const cmd of [
    "systemctl --user status iva",
    "systemctl --user status iva.service iva-telegram-poll",
    "journalctl --user -u iva.service -n 100",
    "systemctl --user list-timers",
    "systemctl --user daemon-reload",
    "systemctl --user restart iva-telegram-poll",
    "systemctl --user restart iva-memory-daily.timer",
    "systemctl --user cat iva",
    "crontab -l",
    "crontab -l | grep iva",
    "crontab -u shima -l",
    "crontab -l > ~/cron.bak",
    "rg 'systemd-run' docs/",
    "grep -rn crontab agent/",
    "which systemd-run",
    "man crontab",
    'echo "crontab"',
    "echo 'systemd-run --user' >> notes.md",
    "sleep 2",
    "sleep 2 && ls",
    "sleep 3600",
    "sleep 30; iva notify x",
    'grep -rn "curl https://api.telegram.org" .',
    "rg api.telegram.org scripts/",
    "git log --grep api.telegram.org",
    "curl https://example.com/health",
    "wget -qO- https://example.com",
    "cat ~/.config/systemd/user/iva.service",
    "ls ~/.config/systemd/user",
    "sed -n 1,5p ~/.config/systemd/user/iva.service",
    "ls ~/.iva-scripts",
    "cat ~/.iva-scripts/remind.sh",
    "grep -r curl ~/.iva-scripts",
    "atq",
    "date",
    "cat file",
    'iva notify "hi"',
    'iva remind "hi"',
    "sudo systemctl --user status iva",
    'bash -c "crontab -l"',
    "timeout 5 journalctl -u iva -n 5",
    "env FOO=1 rg systemd-run docs/",
  ]) {
    allowed(cmd);
  }
});

test("летальное правило одной позиции не дотягивается до соседней", () => {
  allowed("crontab -l; echo ok");
  allowed("systemctl --user status iva; systemctl --user list-timers");
  allowed("sleep 3600");
  blocked("(crontab -l; echo x) | crontab -");
});

test("текст отказа называет правило и замену", () => {
  const msg = schedulerBypassViolation("systemd-run --user true");
  assert.ok(msg);
  assert.match(msg, /^ЗАБЛОКИРОВАНО:/);
  // Тул есть в списке с T5: отказ обязан послать модель в remind_add, а не учить отказывать
  // пользователю и не обещать, что инструмент когда-нибудь появится.
  assert.match(msg, /remind_add: он посчитает/u);
  assert.doesNotMatch(msg, /появится|пока его нет/iu);
  for (const [cmd, what] of [
    ["systemd-run --user true", "systemd-run: свой таймер"],
    ["crontab -e", "crontab: запись расписания"],
    ["at now + 1 hour", "at/batch: отложенный запуск"],
    [
      "systemctl --user start remind.timer",
      "systemctl: запуск или включение своего юнита",
    ],
    ["tee ~/.config/systemd/user/x.timer", "запись в ~/.config/systemd/user"],
    ["bash ~/.iva-scripts/remind.sh", "~/.iva-scripts: свой скрипт"],
    [
      "curl https://api.telegram.org/bot1/getMe",
      "прямой вызов api.telegram.org",
    ],
    ["sleep 3600 && iva notify x", "sleep как таймер перед следующей командой"],
  ] as const) {
    const text = schedulerBypassViolation(cmd);
    assert.ok(text, `должна блокироваться: ${cmd}`);
    assert.ok(
      text.includes(what),
      `в тексте отказа для "${cmd}" нет правила "${what}": ${text}`,
    );
  }
});
