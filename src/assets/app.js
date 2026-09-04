/* Progressive enhancement only: the charts are complete static SVG without it. */
(function () {
  'use strict';

  /* theme toggle ---------------------------------------------------------- */
  var root = document.documentElement;
  var btn = document.querySelector('.theme');
  if (btn) {
    btn.addEventListener('click', function () {
      var dark = matchMedia('(prefers-color-scheme: dark)').matches;
      var cur = root.getAttribute('data-theme') || (dark ? 'dark' : 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  }

  /* series toggles + focus ------------------------------------------------ */
  document.querySelectorAll('.figure').forEach(function (fig) {
    fig.querySelectorAll('.chip').forEach(function (chip) {
      var id = chip.dataset.series;
      var series = fig.querySelector('.series[data-series="' + id + '"]');
      if (!series) return;

      chip.addEventListener('click', function () {
        var on = chip.getAttribute('aria-pressed') !== 'false';
        chip.setAttribute('aria-pressed', String(!on));
        series.style.display = on ? 'none' : '';
      });
      chip.addEventListener('pointerenter', function () {
        if (chip.getAttribute('aria-pressed') === 'false') return;
        fig.classList.add('dim');
        series.classList.add('is-focus');
      });
      chip.addEventListener('pointerleave', function () {
        fig.classList.remove('dim');
        series.classList.remove('is-focus');
      });
    });
  });

  /* regression model toggle ----------------------------------------------- */
  document.querySelectorAll('[data-model-btn]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var block = document.getElementById(btn.dataset.target);
      if (!block) return;
      block.dataset.model = btn.dataset.modelBtn;
      block.querySelectorAll('[data-model-btn]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
    });
  });

  /* provider selection ----------------------------------------------------- */
  var picker = document.getElementById('provider-picker');
  if (picker) {
    var section = document.getElementById('providers');
    var boxes = [].slice.call(picker.querySelectorAll('input[data-provider]'));
    var initial = boxes.map(function (b) { return b.checked; });
    var counter = picker.querySelector('[data-shown]');

    function apply() {
      var on = 0;
      boxes.forEach(function (box) {
        var targets = section.querySelectorAll('[data-series="' + box.dataset.provider + '"]');
        for (var i = 0; i < targets.length; i++) targets[i].classList.toggle('is-off', !box.checked);
        if (box.checked) on++;
      });
      if (counter) counter.textContent = String(on);
    }

    picker.addEventListener('change', function (e) {
      if (e.target.dataset.provider) apply();
    });

    picker.addEventListener('click', function (e) {
      var mode = e.target.dataset.pick;
      if (!mode) return;
      boxes.forEach(function (box, i) {
        box.checked = mode === 'all' ? true : mode === 'none' ? false : initial[i];
      });
      apply();
    });
  }

  /* tooltip --------------------------------------------------------------- */
  var tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'status');
  document.body.appendChild(tip);

  function row(label, value) {
    return value ? '<dt>' + label + '</dt><dd>' + value + '</dd>' : '';
  }

  function show(dot) {
    var d = dot.dataset;
    var svg = dot.ownerSVGElement;
    var metric = (svg && svg.dataset.metric) || '';
    tip.innerHTML =
      '<div class="t-name">' + d.name + '</div>' +
      '<div class="t-sub">' + d.creator + ' · ' + d.date + '</div>' +
      '<div class="t-score"><b>' + d.score + '</b><span>' + metric + '</span></div>' +
      '<dl>' + row('Class', d.category) + row('Parameters', d.params) + row('Weights', d.license) + '</dl>';

    var r = dot.getBoundingClientRect();
    var x = Math.min(Math.max(r.left + r.width / 2, 140), innerWidth - 140);
    tip.style.left = x + 'px';
    tip.style.top = r.top + 'px';
    tip.setAttribute('data-show', '');
  }

  function hide() { tip.removeAttribute('data-show'); }

  document.querySelectorAll('.chart').forEach(function (svg) {
    svg.addEventListener('pointerover', function (e) {
      var dot = e.target.closest('.dot');
      if (dot) show(dot);
    });
    svg.addEventListener('pointerout', function (e) {
      if (e.target.closest('.dot')) hide();
    });
    svg.addEventListener('focusin', function (e) {
      var dot = e.target.closest('.dot');
      if (dot) show(dot);
    });
    svg.addEventListener('focusout', hide);
  });
  addEventListener('scroll', hide, { passive: true });
})();
